//! Background passes: the scheduler thread, standby engines, per-pass directories, the pass
//! loop with the picture cache, and delivering a pass as a layout. PDF export.

use super::*;
use crate::capture::PassWatch;

// ---------------------------------------------------------------------------------------------
// Background thread: full passes when `schedule` says, with capture, layout installation,
// exports.
// ---------------------------------------------------------------------------------------------
pub(super) fn background_thread(s: Arc<Shared>) {
    prepare_standby(&s);
    'commands: while let Ok(cmd) = s.bg_signal.1.recv() {
        match cmd {
            BgCmd::Quit => break,
            BgCmd::Export(job, out) if !s.shutdown.load(Ordering::SeqCst) => run_export(&s, job, out),
            BgCmd::Export(..) => break,
            BgCmd::Pass => {
                if s.bg_paused.load(Ordering::SeqCst) {
                    s.bg_pending_while_paused.store(true, Ordering::SeqCst);
                    continue;
                }
                // wait for the moment the requests ask for; new requests and edits move it
                let timing = s.pass_timing();
                let run = loop {
                    let first = s.layout.lock().layout_version == 0;
                    let wait = {
                        let mut wish = s.pass_wish.lock();
                        if first {
                            // until the first layout, every request runs at once
                            wish.now();
                        }
                        wish.wait(&timing, Instant::now())
                    };
                    let timeout = match wait {
                        schedule::Wait::Run => break true,
                        schedule::Wait::Nothing => break false,
                        schedule::Wait::For(d) => d,
                    };
                    match s.bg_signal.1.recv_timeout(timeout) {
                        Ok(BgCmd::Pass) | Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                        Ok(BgCmd::Quit) | Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                            break 'commands
                        }
                        Ok(BgCmd::Export(job, out)) if !s.shutdown.load(Ordering::SeqCst) => {
                            run_export(&s, job, out)
                        }
                        Ok(BgCmd::Export(..)) => break 'commands,
                    }
                };
                if s.shutdown.load(Ordering::SeqCst) {
                    break;
                }
                if !run {
                    continue;
                }
                s.pass_wish.lock().take();
                let completed = run_background_pass(&s);
                s.pass_wish.lock().done();
                if completed {
                    prepare_standby(&s);
                } else if let Some(w) = s.standby.lock().take() {
                    // A speculative standby may be stuck in the same preamble.
                    w.kill();
                }
            }
        }
    }
    if let Some(w) = s.standby.lock().take() {
        w.kill();
    }
}

pub(super) fn standby_dir(s: &Shared, n: usize) -> PathBuf {
    s.cfg.build_dir.join(format!("src-body-{n}"))
}

/// Output directory of the pass that runs from `src-body-{n}`. Two alternate: a standby
/// (lualatex up to the end of the preamble) opens its log, and with some preambles its PDF,
/// as soon as it starts, so it must never share a directory with the pass that is running.
pub(super) fn pass_dir(s: &Shared, n: usize) -> PathBuf {
    s.cfg.build_dir.join("bg").join(format!("pass-{n}"))
}

/// The directory of the last finished pass (seeded from disk on the first call: the newer
/// of the two pass directories, or the pre-pass-directory layout `build/bg` itself).
pub(super) fn last_pass_dir(s: &Shared) -> Option<PathBuf> {
    let mut slot = s.last_pass_dir.lock();
    if slot.is_none() {
        let jobname = jobname_of(&s.cfg.main_file);
        let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
        for d in [pass_dir(s, 0), pass_dir(s, 1), s.cfg.build_dir.join("bg")] {
            if let Ok(m) = std::fs::metadata(d.join(format!("{jobname}.aux"))) {
                if let Ok(t) = m.modified() {
                    if best.as_ref().map(|(bt, _)| t > *bt).unwrap_or(true) {
                        best = Some((t, d));
                    }
                }
            }
        }
        *slot = best.map(|(_, d)| d);
    }
    slot.clone()
}

/// The slot (0 or 1) a new standby takes: the one that does not hold the last pass.
/// A standby engine for `slot`: the session's project and sources, the slot's body snapshot
/// and pass directories.
pub(super) fn spawn_standby(
    s: &Shared,
    texts: &BTreeMap<String, String>,
    unit_envs: &str,
    slot: usize,
) -> Result<WarmEngine> {
    WarmEngine::spawn(crate::background::StandbySpec {
        tl: &s.tl,
        project: &s.cfg.project_root,
        files: texts,
        main: &s.cfg.main_file,
        src_dir: &standby_dir(s, slot),
        out_dir: &pass_dir(s, slot),
        instrumented: true,
        unit_envs,
    })
}

pub(super) fn standby_slot(s: &Shared) -> usize {
    match last_pass_dir(s) {
        Some(d) if d.ends_with("pass-0") => 1,
        _ => 0,
    }
}

pub(super) fn jobname_of(main: &str) -> String {
    Path::new(main)
        .file_stem()
        .and_then(|x| x.to_str())
        .unwrap_or("main")
        .to_string()
}

/// The host's log link must follow the last attempted pass, including failures before capture
/// output exists. Publish only after a requested pass has finished; a speculative standby may
/// still be writing its preamble and must never replace these diagnostics.
fn publish_pass_log(s: &Shared, dir: &Path) {
    let jobname = jobname_of(&s.cfg.main_file);
    let log = dir.join(format!("{jobname}.log"));
    if let Err(e) = std::fs::copy(
        &log,
        s.cfg.build_dir.join("bg").join(format!("{jobname}.log")),
    ) {
        log::warn!("background log copy: {e}");
    }
}

/// Start a standby engine for the next background pass (while the user types, it loads the
/// current preamble). Replaces a standby whose preamble is outdated; keeps a matching one.
pub(super) fn prepare_standby(s: &Shared) {
    if !s.cfg.warm_background || s.shutdown.load(Ordering::SeqCst) {
        return;
    }
    let (texts, _, _) = snapshot(s);
    let Some(pre_hash) = standby_preamble_hash(&texts, &s.cfg.main_file) else {
        return;
    };
    let mut slot = s.standby.lock();
    if let Some(w) = slot.as_mut() {
        if w.preamble_hash == pre_hash && w.is_alive() {
            return;
        }
    }
    if let Some(w) = slot.take() {
        w.kill();
    }
    let unit_envs = s.policy.lock().unit_envs_env();
    let n = standby_slot(s);
    match spawn_standby(s, &texts, &unit_envs, n) {
        Ok(w) => *slot = Some(w),
        Err(e) => {
            s.events
                .send(Event::Diagnostics {
                    source: "background".into(),
                    items: vec![Diagnostic {
                        severity: "warning".into(),
                        file: None,
                        line: None,
                        message: format!("standby engine: {e}"),
                        context: None,
                    }],
                })
                .ok();
        }
    }
}

pub(super) fn texts_of(files: &BTreeMap<String, FileBuf>) -> BTreeMap<String, String> {
    files
        .iter()
        .map(|(n, fb)| (n.clone(), fb.text.clone()))
        .collect()
}

/// The preamble the fast server loads: the main file's preamble with `\input`ted files inlined
/// from the buffers, plus the document's body setup statements (`crate::server_preamble`).
pub(super) fn effective_preamble(texts: &BTreeMap<String, String>, main: &str) -> String {
    crate::server_preamble(texts, main)
}

/// The preamble as the standby engine hashes it (`write_body_snapshot`): inputs inlined, no
/// body setup (the standby compiles the whole body itself).
pub(super) fn standby_preamble_hash(texts: &BTreeMap<String, String>, main: &str) -> Option<u64> {
    texts
        .get(main)
        .and_then(|t| crate::split_preamble(t))
        .map(|(p, _)| crate::document::hash_str(&crate::document::expand_inputs(p, texts)))
}

pub(super) fn preamble_input_set(
    texts: &BTreeMap<String, String>,
    main: &str,
) -> std::collections::BTreeSet<String> {
    texts
        .get(main)
        .and_then(|t| crate::split_preamble(t))
        .map(|(p, _)| crate::document::transitive_inputs(p, texts))
        .unwrap_or_default()
}

pub(super) fn snapshot(s: &Shared) -> (BTreeMap<String, String>, Vec<SnapshotSpan>, Revision) {
    let files = s.files.lock();
    let rev = s.source_revision.load(Ordering::SeqCst);
    let policy = s.policy.lock();
    let inputted = s.inputted.lock();
    let mut texts = BTreeMap::new();
    let mut spans = Vec::new();
    for (name, fb) in files.iter() {
        texts.insert(name.clone(), fb.text.clone());
        spans.extend(crate::layout::snapshot_spans_of(
            fb,
            name,
            &policy,
            inputted.contains(name),
        ));
    }
    (texts, spans, rev)
}

fn run_background_pass(s: &Shared) -> bool {
    s.bg_running.store(true, Ordering::SeqCst);
    s.bg_epoch.fetch_add(1, Ordering::SeqCst);
    let started = Instant::now();
    let version = s.layout.lock().layout_version;
    let completed = run_background_pass_inner(s);
    if s.layout.lock().layout_version > version {
        s.full_cost.lock().record(started.elapsed());
    }
    s.bg_running.store(false, Ordering::SeqCst);
    completed
}

/// After the first intermediate result, only slow passes warrant another preview update.
pub(super) const PROVISIONAL_LAYOUT_AFTER: Duration = Duration::from_secs(2);

fn run_background_pass_inner(s: &Shared) -> bool {
    let t0 = Instant::now();
    let (texts, mut spans, rev) = snapshot(s);
    // a pass that cannot run is still a layout result: hosts see compile = Failed instead of a
    // pass that never ends
    let failed = |msg: String| {
        // a clean live result may be the fix: it asks for a pass (`unsettled_any`)
        s.layout.lock().unsettled_any = true;
        s.events
            .send(Event::Diagnostics {
                source: "background".into(),
                items: vec![Diagnostic {
                    severity: "error".into(),
                    file: None,
                    line: None,
                    message: msg.clone(),
                    context: None,
                }],
            })
            .ok();
        *s.convergence.lock() = Some(Convergence::PassLimitReached {
            passes: 0,
            reasons: vec![msg.clone()],
        });
        s.events
            .send(Event::LayoutUpdate {
                source_revision: (std::env::var("RTEX_SOURCE_SYNC").ok().as_deref() == Some("1"))
                    .then_some(rev),
                versions: Versions {
                    source_revision: rev,
                    ..Default::default()
                },
                compile: CompileStatus::Failed,
                convergence: Convergence::PassLimitReached {
                    passes: 0,
                    reasons: vec![msg],
                },
                passes: 0,
                pages_changed: vec![],
                pages_total: 0,
                placements: vec![],
                eligible_paragraphs: vec![],
                pdf_fallback: None,
                wall_ms: t0.elapsed().as_millis() as u64,
            })
            .ok();
        catch_up(s, rev);
    };
    let out_dir = s.cfg.build_dir.join("bg");
    let unit_envs = s.policy.lock().unit_envs_env();
    // picture cache: pictures whose source and surroundings are unchanged come from an earlier
    // pass's PDF; the manifest is refreshed before every pass of the run (a pass's own
    // drawings serve the next one)
    let _ = std::fs::create_dir_all(&out_dir);
    let pics: Vec<crate::piccache::PictureRef> = if s.cfg.picture_cache {
        let pre_hash = crate::piccache::preamble_hash(&texts, &s.cfg.main_file);
        crate::piccache::scan_pictures(&texts, &s.cfg.main_file, pre_hash)
    } else {
        Vec::new()
    };
    let pic_cache =
        std::sync::Mutex::new(crate::piccache::PicCache::open(&out_dir.join("pic-cache")));
    // written into the directory of the pass about to run (the capture reads it from there)
    let refresh_manifest = |dir: &Path| {
        let manifest = dir.join("pic-manifest.json");
        if pics.is_empty() {
            let _ = std::fs::remove_file(&manifest);
            return;
        }
        if let Err(e) = pic_cache.lock().unwrap().write_manifest(&pics, &manifest) {
            log::warn!("picture cache manifest: {e:#}");
        }
    };
    let absorb = |cap: &crate::capture::CaptureResult| {
        if pics.is_empty() {
            return;
        }
        if let Err(e) = pic_cache.lock().unwrap().absorb(
            &pics,
            &cap.json.recorded_pics(),
            &cap.json.pic_mismatch,
            &cap.pdf,
        ) {
            log::warn!("picture cache: {e:#}");
        }
    };
    // the aux family every pass of this run starts from
    let aux_dir = last_pass_dir(s).unwrap_or_else(|| pass_dir(s, 0));
    // before a pass runs in its directory: the previous pass's aux family and the manifest
    let prepare_dir = |dir: &Path| {
        if let Some(from) = last_pass_dir(s) {
            if let Err(e) = crate::background::copy_aux_family(&from, dir) {
                log::warn!("aux family: {e:#}");
            }
        }
        refresh_manifest(dir);
    };
    let finished = |cap: &crate::capture::CaptureResult| {
        *s.last_pass_dir.lock() = Some(cap.out_dir.clone());
    };
    let mut pass_started = Instant::now();
    let mut on_pass = |cap: &crate::capture::CaptureResult, pass: u32| {
        // the host sees the provisional layout before the cache absorbs the pass's pictures
        // (a PDF round trip)
        if pass == 1 || pass_started.elapsed() >= PROVISIONAL_LAYOUT_AFTER {
            deliver_layout(
                s,
                t0,
                cap,
                pass,
                false,
                &mut spans,
                rev,
                true,
            );
        }
        absorb(cap);
        pass_started = Instant::now();
    };
    let mut keep_going =
        || !s.shutdown.load(Ordering::SeqCst) && s.source_revision.load(Ordering::SeqCst) == rev;
    let watch = Some(PassWatch {
        timeout: s.cfg.pass_timeout,
        shutdown: &s.shutdown,
    });
    let result = if s.cfg.warm_background {
        // Every pass of the loop runs in a standby engine: the one prepared while the user
        // typed, then the one started when the previous pass was released (its preamble loads
        // while the body is typeset). Two snapshot directories alternate so a loading standby
        // never rewrites the files a running one reads.
        let pre_hash = standby_preamble_hash(&texts, &s.cfg.main_file);
        let mut runner = |_pass: u32| -> Result<crate::capture::CaptureResult> {
            let ready = {
                let mut slot = s.standby.lock();
                match slot.take() {
                    Some(mut w) => {
                        if Some(w.preamble_hash) == pre_hash && w.is_alive() {
                            Some(w)
                        } else {
                            w.kill();
                            None
                        }
                    }
                    None => None,
                }
            };
            let w = match ready {
                Some(w) => w,
                None => {
                    let slot = standby_slot(s);
                    spawn_standby(s, &texts, &unit_envs, slot)?
                }
            };
            // this pass starts from the last one's aux family, then the next standby starts
            // in the other slot (whose previous results are consumed by now)
            prepare_dir(w.out_dir());
            let other = if w.src_dir.ends_with("src-body-0") {
                1
            } else {
                0
            };
            if let Ok(next) = spawn_standby(s, &texts, &unit_envs, other) {
                *s.standby.lock() = Some(next);
            }
            let dir = w.out_dir().to_path_buf();
            let result = w.run_timed(
                &s.cfg.project_root,
                &texts,
                &s.cfg.main_file,
                watch,
            );
            publish_pass_log(s, &dir);
            let cap = result?;
            finished(&cap);
            Ok(cap)
        };
        crate::background::run_pass_with_runner_controlled(
            crate::background::PassPlan {
                tl: &s.tl,
                snapshot_dir: &standby_dir(s, 0),
                main: &s.cfg.main_file,
                aux_dir: &aux_dir,
                max_passes: s.cfg.max_passes,
                bib: s.cfg.bib_tool,
            },
            &mut runner,
            &mut on_pass,
            &mut keep_going,
        )
    } else {
        // plain passes: a fresh lualatex per pass in pass-0 (sequential, so one directory)
        let snap_dir = snapshot_dir(&s.cfg.build_dir);
        if let Err(e) = write_snapshot(&s.cfg.project_root, &texts, &snap_dir) {
            failed(format!("snapshot: {e}"));
            return false;
        }
        let dir = pass_dir(s, 0);
        let mut runner = |_pass: u32| -> Result<crate::capture::CaptureResult> {
            prepare_dir(&dir);
            let result = crate::capture::run_capture_timed(
                &s.tl,
                &snap_dir,
                &s.cfg.main_file,
                &dir,
                true,
                &unit_envs,
                watch,
            );
            publish_pass_log(s, &dir);
            let cap = result?;
            finished(&cap);
            Ok(cap)
        };
        crate::background::run_pass_with_runner_controlled(
            crate::background::PassPlan {
                tl: &s.tl,
                snapshot_dir: &snap_dir,
                main: &s.cfg.main_file,
                aux_dir: &aux_dir,
                max_passes: s.cfg.max_passes,
                bib: s.cfg.bib_tool,
            },
            &mut runner,
            &mut on_pass,
            &mut keep_going,
        )
    };
    let outcome = match result {
        Ok(o) => o,
        Err(e) => {
            failed(format!("background pass: {e:#}"));
            return false;
        }
    };
    absorb(&outcome.capture);
    let outcome_cap = outcome.capture;
    deliver_layout(
        s,
        t0,
        &outcome_cap,
        outcome.passes,
        outcome.aux_stable,
        &mut spans,
        rev,
        false,
    );
    true
}

pub(super) fn layout_failed(s: &Shared, t0: Instant, rev: Revision, msg: String) {
    s.layout.lock().unsettled_any = true;
    s.events
        .send(Event::Diagnostics {
            source: "background".into(),
            items: vec![Diagnostic {
                severity: "error".into(),
                file: None,
                line: None,
                message: msg.clone(),
                context: None,
            }],
        })
        .ok();
    *s.convergence.lock() = Some(Convergence::PassLimitReached {
        passes: 0,
        reasons: vec![msg.clone()],
    });
    s.events
        .send(Event::LayoutUpdate {
            source_revision: (std::env::var("RTEX_SOURCE_SYNC").ok().as_deref() == Some("1"))
                .then_some(rev),
            versions: Versions {
                source_revision: rev,
                ..Default::default()
            },
            compile: CompileStatus::Failed,
            convergence: Convergence::PassLimitReached {
                passes: 0,
                reasons: vec![msg],
            },
            passes: 0,
            pages_changed: vec![],
            pages_total: 0,
            placements: vec![],
            eligible_paragraphs: vec![],
            pdf_fallback: None,
            wall_ms: t0.elapsed().as_millis() as u64,
        })
        .ok();
    catch_up(s, rev);
}

/// Install a pass's capture as the current layout and tell the host. `provisional`: a pass of a
/// run that is not stable yet (another pass follows); the layout is usable, its convergence is
/// `Converging`.
#[allow(clippy::too_many_arguments)]
pub(super) fn deliver_layout(
    s: &Shared,
    t0: Instant,
    cap: &crate::capture::CaptureResult,
    passes: u32,
    aux_stable: bool,
    spans: &mut Vec<SnapshotSpan>,
    rev: Revision,
    provisional: bool,
) {
    let mut diagnostics = parse_log(&cap.log);
    for d in &mut diagnostics {
        // the standby reads the preamble from rtex-preamble.tex (same line numbers)
        if d.file
            .as_deref()
            .map(|f| f.ends_with("rtex-preamble.tex"))
            .unwrap_or(false)
        {
            d.file = Some(s.cfg.main_file.clone());
        }
    }
    let errors = diagnostics.iter().filter(|d| d.severity == "error").count();
    let compile = if cap.json.pages == 0 {
        CompileStatus::Failed
    } else if errors > 0 {
        CompileStatus::CompiledWithErrors { count: errors }
    } else {
        CompileStatus::Ok
    };
    if compile == CompileStatus::Failed {
        // the previous layout stays; a clean live result may be the fix and asks for a pass
        s.layout.lock().unsettled_any = true;
        s.events
            .send(Event::Diagnostics {
                source: "background".into(),
                items: diagnostics,
            })
            .ok();
        s.events
            .send(Event::LayoutUpdate {
                source_revision: (std::env::var("RTEX_SOURCE_SYNC").ok().as_deref() == Some("1"))
                    .then_some(rev),
                versions: Versions {
                    source_revision: rev,
                    ..Default::default()
                },
                compile,
                convergence: Convergence::PassLimitReached {
                    passes,
                    reasons: vec!["no pages".into()],
                },
                passes,
                pages_changed: vec![],
                pages_total: 0,
                placements: vec![],
                eligible_paragraphs: vec![],
                pdf_fallback: None,
                wall_ms: t0.elapsed().as_millis() as u64,
            })
            .ok();
        catch_up(s, rev);
        return;
    }
    let (changed, versions, placements, eligible, eligible_strict, pdf) = {
        // lock order everywhere: files, then layout, then policy (apply_edit holds the first two
        // together)
        let mut files = s.files.lock();
        // Capture facts may change source boundaries only while this snapshot is current.
        if s.source_revision.load(Ordering::SeqCst) == rev
            && s.preamble_revision.load(Ordering::SeqCst) <= rev
        {
            let names: Vec<_> = cap.json.units.iter().filter(|u| u.kind == "heading" && u.runin)
                .filter_map(|u| u.name.clone()).collect();
            let mut changed = false;
            let mut ids = s.ids.lock();
            for fb in files.values_mut() {
                changed |= fb.learn_run_in_headings(&names, &mut ids, rev);
            }
            if changed {
                let policy = s.policy.lock();
                let inputted = s.inputted.lock();
                *spans = files.iter().flat_map(|(name, fb)| {
                    crate::layout::snapshot_spans_of(fb, name, &policy, inputted.contains(name))
                }).collect();
            }
        }
        let mut layout = s.layout.lock();
        let changed = match layout.install(cap, spans.clone(), rev) {
            Ok(c) => {
                // the PDF hosts render degraded pages from: a copy per layout, since the next
                // pass (started right after this one, a provisional layout's in particular)
                // rewrites the pass PDF while the host reads it
                let v = layout.layout_version;
                let bg = s.cfg.build_dir.join("bg");
                let stable = bg.join(format!("layout-{v}.pdf"));
                match std::fs::copy(&cap.pdf, &stable) {
                    Ok(_) => {
                        layout.pdf = Some(stable.clone());
                        // the two previous copies stay: a host may still be reading the layout
                        // before the one it is replacing
                        if v >= 3 {
                            let _ = std::fs::remove_file(bg.join(format!("layout-{}.pdf", v - 3)));
                        }
                        // build/bg/<jobname>.pdf: the latest layout, for hosts that
                        // name these files themselves (a link to the copy; nothing writes
                        // them in place)
                        let main_pdf = bg.join(format!("{}.pdf", cap.jobname));
                        let _ = std::fs::remove_file(&main_pdf);
                        if std::fs::hard_link(&stable, &main_pdf).is_err() {
                            let _ = std::fs::copy(&stable, &main_pdf);
                        }
                    }
                    Err(e) => log::warn!("layout PDF copy: {e}"),
                }
                layout.mark_unsettled(
                    diagnostics
                        .iter()
                        .filter(|d| d.severity == "error")
                        .map(|d| (d.file.as_deref(), d.line)),
                );
                c
            }
            Err(e) => {
                drop(layout);
                drop(files);
                layout_failed(s, t0, rev, format!("install layout: {e}"));
                return;
            }
        };
        let versions = Versions {
            source_revision: s.source_revision.load(Ordering::SeqCst),
            context_revision: layout.context_revision,
            engine_generation: s.engine_generation.load(Ordering::SeqCst),
            layout_version: layout.layout_version,
        };
        let mut placements = Vec::new();
        let mut eligible = Vec::new();
        // units whose vocabulary the allow-list fully knows (safe to compile unprobed)
        let mut eligible_strict: Vec<ParaId> = Vec::new();
        let policy = s.policy.lock().clone();
        for (id, idx) in &layout.by_span {
            let eu = &layout.units[*idx];
            let c = &eu.captured;
            let rows: Vec<(i64, i64)> = c.placements.iter().map(|p| (p.x, p.y)).collect();
            let kind = match c.kind.as_str() {
                "par" => "par".to_string(),
                k => format!("{k}:{}", c.name.clone().unwrap_or_default()),
            };
            if let Some((frags, _)) = layout.fragments(*id, &rows) {
                placements.push(ParagraphPlacement {
                    par_id: *id,
                    fragments: frags,
                    lines: eu.rows(),
                    kind,
                });
            }
            let has_ctx = eu.has_context();
            // eligible = capture facts clean AND the span's source passes the allow-list with the
            // shape the capture saw (what apply_edit will decide for a one-character edit)
            let source_ok = layout
                .snapshot_spans
                .iter()
                .find(|sp| sp.id == *id)
                .map(|sp| !sp.background_only)
                .unwrap_or(false)
                && files
                    .values()
                    .find_map(|fb| fb.span_text(*id))
                    .map(|text| {
                        let (shape, _) = classify_source(text, &policy);
                        match (&shape, c.kind.as_str()) {
                            (UnitShape::Par, "par") => true,
                            (UnitShape::Env(n), "env") => Some(n.as_str()) == c.name.as_deref(),
                            (UnitShape::Heading(n), "heading") => {
                                Some(n.as_str()) == c.name.as_deref()
                            }
                            _ => false,
                        }
                    })
                    .unwrap_or(false);
            if source_ok
                && check_engine_unit(
                    &c.kind,
                    &c.everypar,
                    has_ctx,
                    eu.rows(),
                    &eu.flags,
                    c.name.as_deref().filter(|name| c.runin && !files.values().any(|fb| fb.run_in_headings.iter().any(|n| n == name))),
                )
                .is_empty()
            {
                eligible.push(*id);
                let strict_ok = files
                    .values()
                    .find_map(|fb| fb.span_text(*id))
                    .map(|text| classify_source_with(text, &policy, false).1.is_empty())
                    .unwrap_or(false);
                if strict_ok && !c.runin {
                    eligible_strict.push(*id);
                }
            }
        }
        drop(files);
        placements.sort_by_key(|p| p.par_id);
        eligible.sort();
        eligible_strict.sort();
        (
            changed,
            versions,
            placements,
            eligible,
            eligible_strict,
            layout.pdf.clone(),
        )
    };
    // warm the engine: compile the first allow-listed paragraph once so fonts are loaded before
    // the first real keystroke (never an unprobed unit: it could leak state)
    if let Some(id) = eligible_strict.first().copied() {
        let files = s.files.lock();
        let layout = s.layout.lock();
        if let (Some(eu), Some(text)) = (
            layout.unit(id),
            files.values().find_map(|fb| fb.span_text(id)),
        ) {
            let mut p = s.pending.lock();
            if let std::collections::btree_map::Entry::Vacant(e) = p.entry(id) {
                // exercise the font variants and math a body paragraph commonly needs so their
                // font instances are loaded before the first real keystroke
                let warm = format!("{} \\emph{{warm}} \\textbf{{warm}} \\textit{{warm}} \\textsc{{warm}} {{\\small warm}} $x^2_i + \\alpha \\sum \\frac{{1}}{{2}} \\mathbf{{v}}$", text.trim_end_matches('\n'));
                e.insert(FastRequest {
                    queued_at: Instant::now(),
                    sample_epoch: None,
                    warmup: true,
                    par_id: id,
                    edit_id: 0,
                    span_hash: 0,
                    source: warm,
                    source_file: String::new(),
                    source_first_line: 1,
                    pics: String::new(),
                    pics_n: 0,
                    seq: eu.uid,
                    ctx: None,
                    versions: Versions {
                        source_revision: rev,
                        context_revision: layout.context_revision,
                        engine_generation: s.engine_generation.load(Ordering::SeqCst),
                        layout_version: layout.layout_version,
                    },
                    context_stale: false,
                    expected_rows: 0,
                    probe: false,
                    pics_required: false,
                });
                s.pending_signal.0.send(()).ok();
            }
        }
    }
    // borrowed contexts, live rows and placements are superseded by the new placements, and
    // facts tagged with an older layout no longer apply
    // units typeset broken whose verified verdict still holds: the pass saw a structure being
    // typed, or a TeX error the live engine reported as well (where only the full compile
    // errs, the probe must judge again)
    {
        let files = s.files.lock();
        let layout = s.layout.lock();
        let mut live = s.live.lock();
        let broken: HashSet<ParaId> = layout
            .unsettled
            .iter()
            .filter(|id| {
                layout.snapshot_unfinished(**id) || live.get(**id).is_some_and(|u| u.live_error)
            })
            .copied()
            .collect();
        let current = files
            .values()
            .flat_map(|fb| fb.spans.iter().map(|sp| sp.id))
            .collect();
        live.on_new_layout(&layout, &current, &broken);
    }
    let current = s.source_revision.load(Ordering::SeqCst);
    let mut reasons = Vec::new();
    if !aux_stable {
        reasons.push("aux family still changing".into());
    }
    if errors > 0 {
        reasons.push(format!("{errors} compile errors"));
    }
    let convergence = if current > rev {
        Convergence::Stale {
            pending_since: rev + 1,
        }
    } else if provisional {
        Convergence::Converging {
            pass: passes,
            reasons: vec!["another pass is running".into()],
        }
    } else if aux_stable && errors == 0 {
        Convergence::Converged
    } else if !aux_stable && passes >= s.cfg.max_passes {
        Convergence::PassLimitReached {
            passes,
            reasons: reasons.clone(),
        }
    } else {
        Convergence::Converging {
            pass: passes,
            reasons: reasons.clone(),
        }
    };
    *s.convergence.lock() = Some(convergence.clone());
    let pages_changed: Vec<PageUpdate> = {
        let layout = s.layout.lock();
        changed
            .iter()
            .filter_map(|n| {
                layout.pages.get(n).map(|dl| PageUpdate {
                    page: *n,
                    exact: dl.is_exact(),
                    hash: layout.page_hashes[n],
                    dl: dl.clone(),
                })
            })
            .collect()
    };
    let pages_total = cap.json.pages;
    if !diagnostics.is_empty() {
        s.events
            .send(Event::Diagnostics {
                source: "background".into(),
                items: diagnostics,
            })
            .ok();
    }
    // the fallback is named whenever the layout has a degraded page, changed in this
    // layout or not: a host that keeps one PDF per layout needs the current file
    let any_degraded = {
        let layout = s.layout.lock();
        layout.pages.values().any(|dl| !dl.is_exact())
    };
    s.events
        .send(Event::LayoutUpdate {
            source_revision: (std::env::var("RTEX_SOURCE_SYNC").ok().as_deref() == Some("1"))
                .then_some(rev),
            versions,
            compile,
            convergence: convergence.clone(),
            passes,
            pages_changed,
            pages_total,
            placements,
            eligible_paragraphs: eligible,
            pdf_fallback: if any_degraded { pdf } else { None },
            wall_ms: t0.elapsed().as_millis() as u64,
        })
        .ok();
    if matches!(convergence, Convergence::Stale { .. }) {
        catch_up(s, rev);
    }
}

/// Edits arrived during the pass that delivered (or failed on) snapshot `rev`: another pass
/// catches up once the writer pauses. When only unfinished structures grew meanwhile, they ask
/// for their own pass when they settle, and closing them live makes the catch-up due.
fn catch_up(s: &Shared, rev: Revision) {
    if s.source_revision.load(Ordering::SeqCst) <= rev {
        return;
    }
    let mut wish = s.pass_wish.lock();
    if wish.changed() {
        drop(wish);
        s.need_pass();
    } else {
        wish.owe_stale();
    }
}

pub(super) fn run_export(s: &Shared, job: u64, out: PathBuf) {
    let (texts, _spans, _rev) = snapshot(s);
    let snap_dir = s.cfg.build_dir.join("export-src");
    if let Err(e) = write_snapshot(&s.cfg.project_root, &texts, &snap_dir) {
        s.events
            .send(Event::PdfExported {
                job_id: job,
                path: None,
                status: CompileStatus::Failed,
                converged: false,
                passes: 0,
            })
            .ok();
        let _ = e;
        return;
    }
    let out_dir = s.cfg.build_dir.join("export");
    match run_pass_timed(
        &s.tl,
        &snap_dir,
        &s.cfg.main_file,
        &out_dir,
        s.cfg.max_passes,
        s.cfg.bib_tool,
        false,
        "",
        Some(PassWatch {
            timeout: s.cfg.pass_timeout,
            shutdown: &s.shutdown,
        }),
    ) {
        Ok(o) => {
            let diags = parse_log(&o.capture.log);
            let errors = diags.iter().filter(|d| d.severity == "error").count();
            // A fatal TeX error can leave a truncated PDF after earlier pages were shipped.
            let usable_pdf = lopdf::Document::load(&o.capture.pdf)
                .map(|pdf| !pdf.get_pages().is_empty())
                .unwrap_or(false);
            let status = if !usable_pdf {
                CompileStatus::Failed
            } else if errors > 0 {
                CompileStatus::CompiledWithErrors { count: errors }
            } else {
                CompileStatus::Ok
            };
            let path = if usable_pdf {
                if let Some(parent) = out.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::copy(&o.capture.pdf, &out)
                    .ok()
                    .map(|_| out.clone())
            } else {
                None
            };
            s.events
                .send(Event::PdfExported {
                    job_id: job,
                    path,
                    status,
                    converged: o.aux_stable && errors == 0,
                    passes: o.passes,
                })
                .ok();
        }
        Err(e) => {
            log::error!("PDF export: {e:#}");
            s.events
                .send(Event::PdfExported {
                    job_id: job,
                    path: None,
                    status: CompileStatus::Failed,
                    converged: false,
                    passes: 0,
                })
                .ok();
        }
    }
}
