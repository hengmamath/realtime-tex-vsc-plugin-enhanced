//! The engine thread: owns the fast server, sends queued requests, collects results (direct
//! or queued), runs probes and warm-ups, and turns results into paragraph updates or demotions.

use super::*;

// ---------------------------------------------------------------------------------------------
// Engine thread: owns the fast server; coalesces pending requests (latest per paragraph).
// ---------------------------------------------------------------------------------------------
pub(super) fn engine_thread(s: Arc<Shared>) {
    EngineLoop {
        s,
        server: None,
        server_generation: u64::MAX,
        labels_sent: 0,
        server_bbl: None,
        standby: None,
        bbl_checked: u64::MAX,
    }
    .run();
}

/// The engine thread's own state: the server it owns and what it has sent to that server.
struct EngineLoop {
    s: Arc<Shared>,
    server: Option<FastServer>,
    server_generation: u64,
    labels_sent: u64,
    /// Hash of the `.bbl` the running server read at `\begin{document}` (None: it had none).
    /// biblatex reads its data once, so a newer one needs a new server (`refresh_bibliography`).
    server_bbl: Option<u64>,
    /// A server starting with a newer `.bbl` while the running one keeps serving.
    standby: Option<Standby>,
    /// The layout version whose `.bbl` was last compared with the server's.
    bbl_checked: u64,
}

/// A server for the latest bibliography (`refresh_bibliography`): starting on a helper thread,
/// then ready and waiting for the running server to be idle.
struct Standby {
    generation: u64,
    state: StandbyState,
}

enum StandbyState {
    Starting(std::thread::JoinHandle<Result<FastServer>>),
    Ready(Box<FastServer>),
}

/// Hash of the `.bbl` next to `aux` (None: there is none).
fn bbl_hash(aux: Option<&Path>) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let bytes = std::fs::read(aux?.with_extension("bbl")).ok()?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    Some(h.finish())
}

/// Hash of the `.bbl` a started server read: the copy it made at start, not the pass's file,
/// which a later pass in the same directory may already have rewritten.
fn server_bbl_hash(srv: &FastServer) -> Option<u64> {
    bbl_hash(Some(
        &srv.work_dir
            .join(format!("rtex-serve-g{}.aux", srv.generation)),
    ))
}

/// The aux file of the latest layout's pass (a server starts from it and its `.bbl`), with
/// that layout's version, read together.
fn layout_aux(s: &Shared) -> (Option<PathBuf>, u64) {
    let layout = s.layout.lock();
    let jobname = Path::new(&s.cfg.main_file)
        .file_stem()
        .and_then(|x| x.to_str())
        .unwrap_or("main")
        .to_string();
    (
        layout
            .capture_dir
            .as_ref()
            .map(|d| d.join(format!("{jobname}.aux"))),
        layout.layout_version,
    )
}

/// The link fields that describe the current server, cleared when it goes away.
fn reset_link(s: &Shared) {
    let mut l = s.link.lock();
    l.writer = None;
    let abandoned = l.inflight.take();
    l.contexts_sent.clear();
    drop(l);
    let mut live = s.live.lock();
    if let Some(fl) = abandoned {
        live.unit(fl.req.par_id).cost.cancel_trial(Instant::now());
    }
    live.on_server_replacement();
}

/// A probe or startup can finish after the host has queued a newer edit. Putting the older
/// request back must never replace that correction (a warm-up has edit id zero).
fn queue_latest(s: &Shared, req: FastRequest) {
    let mut pending = s.pending.lock();
    if pending
        .get(&req.par_id)
        .is_none_or(|queued| queued.edit_id < req.edit_id)
    {
        pending.insert(req.par_id, req);
    }
    drop(pending);
    s.pending_signal.0.send(()).ok();
}

/// Restarts for a failed compile or a bibliography refresh keep the same preamble. Requests
/// already queued (including ones enqueued concurrently with the restart) remain valid;
/// requests from before a preamble edit do not.
fn rebase_generation(req: &mut FastRequest, wanted_gen: u64, preamble_rev: Revision) -> bool {
    if req.versions.engine_generation == wanted_gen {
        return true;
    }
    if req.versions.engine_generation < wanted_gen && req.versions.source_revision >= preamble_rev {
        req.versions.engine_generation = wanted_gen;
        return true;
    }
    false
}

/// Keep cooldown requests in the coalescing queue while other paragraphs continue live.
/// Check again here because they may have queued before the failure was observed.
fn take_ready_request(
    s: &Shared,
    wanted_gen: u64,
    now: Instant,
) -> (Option<FastRequest>, Option<Duration>) {
    let mut rejected = Vec::new();
    let mut wait: Option<Duration> = None;
    let mut ready = None;
    let mut reroute = Vec::new();
    {
        let files = s.files.lock();
        let layout = s.layout.lock();
        let live = s.live.lock();
        let mut pending = s.pending.lock();
        let mut candidates: Vec<ParaId> = pending.keys().copied().collect();
        candidates.sort_by_key(|id| {
            let req = &pending[id];
            let mut at = Some(*id);
            let mut deferred = false;
            for _ in 0..pending.len() {
                let Some(id) = at else { break };
                deferred |= live.get(id).is_some_and(|u| u.cost.is_deferred());
                at = live.get(id).and_then(|u| u.derived).map(|(_, anchor, _)| anchor)
                    .filter(|anchor| pending.get(anchor).is_some_and(|r| !r.warmup));
            }
            (req.warmup, deferred, std::cmp::Reverse(req.edit_id), *id)
        });
        let mut ids = Vec::new();
        for id in candidates {
            let mut chain = Vec::new();
            let mut at = Some(id);
            while let Some(id) = at.filter(|id| !chain.contains(id) && !ids.contains(id)) {
                chain.push(id);
                at = live.get(id).and_then(|u| u.derived)
                    .map(|(_, anchor, _)| anchor).filter(|anchor| pending.get(anchor).is_some_and(|r| !r.warmup));
            }
            ids.extend(chain.into_iter().rev());
        }
        let preamble_rev = s.preamble_revision.load(Ordering::SeqCst);
        for id in ids {
            if live.get(id).and_then(|u| u.derived)
                .is_some_and(|(_, anchor, _)| pending.get(&anchor).is_some_and(|r| !r.warmup)) {
                continue;
            }
            let req = pending.get_mut(&id).unwrap();
            let current = if req.warmup {
                // Warm-ups have no source file/hash: they add synthetic font exercises to
                // a layout unit. Only its exact context and an unchanged source unit qualify.
                layout.snapshot_revision >= preamble_rev
                    && req.versions.layout_version == layout.layout_version
                    && req.versions.context_revision == layout.context_revision
                    && layout.unit(id).is_some_and(|eu| eu.uid == req.seq)
                    && files
                        .values()
                        .find_map(|fb| fb.span(id))
                        .is_some_and(|sp| sp.last_revision <= req.versions.source_revision)
                    && live
                        .get(id)
                        .is_none_or(|u| !u.warmup_failed && u.recovery.is_none())
            } else {
                files
                    .get(&req.source_file)
                    .and_then(|fb| fb.span(id))
                    .is_some_and(|sp| sp.hash == req.span_hash)
            };
            if !current || !rebase_generation(req, wanted_gen, preamble_rev) {
                pending.remove(&id);
                continue;
            }
            if !req.warmup {
                if layout.snapshot_revision >= req.versions.source_revision
                    && layout.snapshot_text(id) == Some(req.source.as_str()) {
                    pending.remove(&id);
                    continue;
                }
                let semantic_stale = s.semantic_change.lock().as_ref().is_some_and(|change|
                    change.revision > layout.snapshot_revision && change.origin != id);
                if req.versions.context_revision != layout.context_revision
                    || req.versions.layout_version != layout.layout_version || semantic_stale {
                    reroute.push(pending.remove(&id).unwrap());
                    continue;
                }
                if !live.get(id).is_none_or(|u| u.cost.allows(now)) {
                    wait = Some(wait.map_or(Duration::from_secs(1), |w| w.min(Duration::from_secs(1))));
                    continue;
                }
            }
            match live.recovery_gate(id, req.span_hash, now) {
                RecoveryGate::Ready => {
                    ready = pending.remove(&id);
                    break;
                }
                RecoveryGate::Wait(delay) => wait = Some(wait.map_or(delay, |w| w.min(delay))),
                RecoveryGate::Blocked(why) => {
                    rejected.push((pending.remove(&id).unwrap(), why));
                }
            }
        }
    }
    for req in reroute {
        reroute_request(s, req);
    }
    for (req, why) in rejected {
        if !req.warmup {
            demote_span(s, &req, why);
        }
    }
    (ready, wait)
}

fn reroute_request(s: &Shared, previous: FastRequest) {
    let Some(routed) = refresh_request(s, &previous) else { return };
    match routed {
        (Some(mut req), _) => {
            req.queued_at = previous.queued_at;
            queue_latest(s, req);
        }
        (None, reasons) => demote_span(s, &previous, &reasons.join(", ")),
    }
}

fn refresh_request(s: &Shared, previous: &FastRequest) -> Option<(Option<FastRequest>, Vec<String>)> {
    let routed = {
        let files = s.files.lock();
        let fb = files.get(&previous.source_file)?;
        let span = fb.span(previous.par_id).filter(|sp| sp.hash == previous.span_hash)?;
        let layout = s.layout.lock();
        if layout.snapshot_revision >= previous.versions.source_revision
            && layout.snapshot_text(previous.par_id) == Some(previous.source.as_str()) { return None }
        s.route_span(&previous.source_file, &files, fb, span,
            s.source_revision.load(Ordering::SeqCst), previous.edit_id, &layout, &s.policy.lock())
    };
    Some(routed)
}

/// What the probe of a unit decided for this iteration.
enum ProbeOutcome {
    /// Proven (now or earlier for this layout): send the compile.
    Send(FastRequest),
    /// Handled (demoted, requeued, or the engine failed): next iteration.
    Done,
}

impl EngineLoop {
    /// One iteration per request or event: 1. collect a result in flight; 2. take the next
    /// queued request; 3. (re)start the server; 3b. send labels; 4. send the context; 4b. probe
    /// (probe mode); 5. send the compile. A step that settles the iteration returns false (or
    /// nothing to go on with) and the loop starts over.
    fn run(mut self) {
        loop {
            if self.s.shutdown.load(Ordering::SeqCst) {
                reset_link(&self.s);
                if let Some(mut srv) = self.server.take() {
                    let _ = srv.shutdown();
                }
                return;
            }
            let wanted_gen = self.s.engine_generation.load(Ordering::SeqCst);
            if self.collect_inflight(wanted_gen) {
                continue;
            }
            if self.refresh_bibliography(wanted_gen) {
                continue;
            }
            let Some(req) = self.next_request(wanted_gen) else {
                continue;
            };
            if !self.ensure_server(wanted_gen) || !self.sync_labels(wanted_gen) {
                if let Some(req) = req {
                    // Startup already backs off on failure. The next iteration rechecks
                    // source, preamble and recovery eligibility before another attempt.
                    queue_latest(&self.s, req);
                }
                continue;
            }
            let Some(req) = req else { continue };
            self.serve(req, wanted_gen);
        }
    }

    /// Drop the server (its process is killed) and the link's view of it.
    fn drop_server(&mut self) {
        self.server = None;
        reset_link(&self.s);
    }

    /// Step 1: A compile is in flight (sent by us or directly by the host): read its result. True
    /// when there was one (the iteration is settled).
    fn collect_inflight(&mut self, wanted_gen: u64) -> bool {
        let s = self.s.clone();
        let inflight_gen = s
            .link
            .lock()
            .inflight
            .as_ref()
            .map(|f| f.req.versions.engine_generation);
        let Some(gen) = inflight_gen else {
            return false;
        };
        let srv_ok = self.server.is_some() && self.server_generation == gen && gen == wanted_gen;
        if !srv_ok {
            let abandoned = s.link.lock().inflight.take();
            if let Some(fl) = abandoned.filter(|fl|
                s.preamble_revision.load(Ordering::SeqCst) <= fl.req.versions.source_revision) {
                s.live.lock().unit(fl.req.par_id).cost.cancel_trial(Instant::now());
            }
            return true;
        }
        let srv = self.server.as_mut().unwrap();
        let result = srv.recv();
        srv.timeout = compile_timeout(&s.cfg);
        let Some(fl) = s.link.lock().inflight.take() else {
            return true;
        };
        let failure = match result {
            Ok(Response::Result(cr)) => {
                let rt = crate::engine::RoundTrip {
                    total: fl.t0.elapsed(),
                    t_tex: Duration::from_micros(cr.t_tex_us as u64),
                    t_traverse: Duration::from_micros(cr.t_traverse_us as u64),
                    t_pack: Duration::from_micros(cr.t_pack_us as u64),
                };
                handle_result(&s, fl.req, *cr, rt, fl.t0, wanted_gen);
                return true;
            }
            Ok(Response::Fatal {
                reason,
                errors,
                before,
                after,
                ..
            }) => anyhow!("engine fatal: {reason} {errors:?} before=[{before}] after=[{after}]"),
            Ok(other) => anyhow!("unexpected response {other:?}"),
            Err(e) => e,
        };
        engine_failed(&s, &fl.req, failure, wanted_gen, self.server.as_ref());
        self.drop_server();
        true
    }

    /// Step 2: The next queued request (the smallest unit id). None: the iteration is settled
    /// (nothing to do and the server is fine: waited for a signal; or the request was
    /// superseded). Some(None): nothing queued but the server needs attention.
    fn next_request(&mut self, wanted_gen: u64) -> Option<Option<FastRequest>> {
        let s = &self.s;
        let (req, cooldown) = take_ready_request(s, wanted_gen, Instant::now());
        if req.is_none()
            && self.server.is_some()
            && self.server_generation == wanted_gen
            && self.server.as_mut().unwrap().is_alive()
        {
            let delay = cooldown
                .unwrap_or(Duration::from_millis(200))
                .min(Duration::from_millis(200));
            let _ = s.pending_signal.1.recv_timeout(delay);
            return None;
        }
        Some(req)
    }

    /// Step 1b: biblatex reads its `.bbl` once, at `\begin{document}`: a server started before
    /// the pass that wrote the bibliography (a session opened without an earlier build), or
    /// before the bibliography changed, prints citations as unresolved keys, and the probe
    /// keeps every citing unit on the pass. When the latest layout's `.bbl` differs from the
    /// server's, a server is started with it on a helper thread while the running one keeps
    /// serving, and replaces it once ready and idle. True: the iteration is settled (swapped).
    fn refresh_bibliography(&mut self, wanted_gen: u64) -> bool {
        let s = self.s.clone();
        if let Some(mut sb) = self.standby.take() {
            if let StandbyState::Starting(handle) = sb.state {
                if !handle.is_finished() {
                    sb.state = StandbyState::Starting(handle);
                    self.standby = Some(sb);
                    return false;
                }
                match handle.join() {
                    Ok(Ok(srv)) => sb.state = StandbyState::Ready(Box::new(srv)),
                    Ok(Err(e)) => {
                        log::warn!("standby server for the new bibliography: {e:#}");
                        return false;
                    }
                    Err(_) => return false,
                }
            }
            let StandbyState::Ready(mut srv) = sb.state else {
                unreachable!()
            };
            // only onto the server it was started to replace (a preamble change meanwhile
            // restarts the engine anyway)
            if self.server_generation != wanted_gen || sb.generation != wanted_gen + 1 {
                srv.kill();
                return false;
            }
            // and only while nothing is in flight or queued (try again next iteration); the
            // check and the swap of the link happen under one lock, so a host thread cannot
            // write a compile to the old server in between (it sees the new generation and
            // queues the request, which `next_request` carries over)
            srv.timeout = compile_timeout(&s.cfg).max(Duration::from_secs(30)); // first compile loads fonts
            {
                let mut l = s.link.lock();
                let idle = l.inflight.is_none() && s.pending.lock().is_empty();
                if !idle
                    || s.engine_generation
                        .compare_exchange(
                            wanted_gen,
                            sb.generation,
                            Ordering::SeqCst,
                            Ordering::SeqCst,
                        )
                        .is_err()
                {
                    drop(l);
                    sb.state = StandbyState::Ready(srv);
                    self.standby = Some(sb);
                    return false;
                }
                l.writer = srv.stdin_clone().ok();
                l.generation = sb.generation;
                l.contexts_sent.clear();
                l.inflight = None;
            }
            if let Some(mut old) = self.server.replace(*srv) {
                let _ = old.shutdown();
            }
            self.server_generation = sb.generation;
            self.server_bbl = self.server.as_ref().and_then(server_bbl_hash);
            self.labels_sent = 0;
            // verdicts reached against the old server's citations no longer apply
            s.live.lock().on_server_swap();
            s.events
                .send(Event::EngineState {
                    engine_generation: sb.generation,
                    state: "Ready".into(),
                    reason: Some("restarted with the bibliography of the latest layout".into()),
                })
                .ok();
            return true;
        }
        let (aux, lv) = layout_aux(&s);
        if lv == self.bbl_checked
            || self.server_generation != wanted_gen
            || !self.server.as_mut().is_some_and(|srv| srv.is_alive())
        {
            return false;
        }
        self.bbl_checked = lv;
        let bbl = bbl_hash(aux.as_deref());
        if bbl.is_none() || bbl == self.server_bbl {
            return false;
        }
        let preamble = effective_preamble(&texts_of(&s.files.lock()), &s.cfg.main_file);
        let generation = wanted_gen + 1;
        let s2 = s.clone();
        let handle = std::thread::spawn(move || {
            FastServer::spawn_with(
                &s2.tl,
                &s2.cfg.project_root,
                &s2.cfg.build_dir.join("serve-next"),
                &preamble,
                generation,
                aux.as_deref(),
                s2.cfg.debug_dir.is_some(),
            )
        });
        self.standby = Some(Standby {
            generation,
            state: StandbyState::Starting(handle),
        });
        false
    }

    /// Step 3: (Re)start the server when the generation changed or it died. A preamble edit bumps
    /// the generation per keystroke; wait until it has been quiet for the debounce time so a
    /// burst of preamble keystrokes costs one restart, not one per keystroke. False: the
    /// iteration is settled (the generation moved on, or the start failed).
    fn ensure_server(&mut self, wanted_gen: u64) -> bool {
        let s = self.s.clone();
        let healthy = self.server_generation == wanted_gen
            && self.server.as_mut().is_some_and(|srv| srv.is_alive());
        if healthy {
            return true;
        }
        if self.server.is_some() && self.server_generation != wanted_gen {
            let mut g = wanted_gen;
            loop {
                let _ = s.pending_signal.1.recv_timeout(s.cfg.debounce);
                let now = s.engine_generation.load(Ordering::SeqCst);
                if now == g || s.shutdown.load(Ordering::SeqCst) {
                    break;
                }
                g = now;
            }
            if g != wanted_gen {
                return false; // re-evaluate with the settled generation
            }
        }
        reset_link(&s);
        if let Some(mut old) = self.server.take() {
            old.kill();
        }
        let preamble = effective_preamble(&texts_of(&s.files.lock()), &s.cfg.main_file);
        if !publish_startup_state(&s, wanted_gen, "Starting", || None) {
            return false;
        }
        // the layout the server starts from: its .bbl is compared with later layouts'
        let (aux, aux_layout) = layout_aux(&s);
        match FastServer::spawn_with(
            &s.tl,
            &s.cfg.project_root,
            &s.cfg.build_dir.join("serve"),
            &preamble,
            wanted_gen,
            aux.as_deref(),
            s.cfg.debug_dir.is_some(),
        ) {
            Ok(mut srv) => {
                // The writer may have fixed the preamble while startup loaded packages.
                // That old process must never become the current link or clear the error.
                if !startup_is_current(&s, wanted_gen) {
                    srv.kill();
                    return false;
                }
                srv.timeout = compile_timeout(&s.cfg).max(Duration::from_secs(30)); // first compile loads fonts
                {
                    let mut l = s.link.lock();
                    l.writer = srv.stdin_clone().ok();
                    l.generation = wanted_gen;
                    l.contexts_sent.clear();
                    l.inflight = None;
                }
                self.server_bbl = server_bbl_hash(&srv);
                self.server = Some(srv);
                self.server_generation = wanted_gen;
                self.bbl_checked = aux_layout;
                self.labels_sent = 0;
                if !publish_startup_state(&s, wanted_gen, "Ready", || None) {
                    self.drop_server();
                    return false;
                }
                true
            }
            Err(e) => {
                if publish_startup_state(&s, wanted_gen, "Failed", || {
                    Some(debug_bundle_startup(&s, wanted_gen, &format!("{e:#}")))
                }) {
                    std::thread::sleep(Duration::from_secs(1));
                }
                false
            }
        }
    }

    /// Step 3b: Labels (\newlabel/\bibcite of the last pass) when they changed; done while idle
    /// when possible, and before a compile otherwise. False: the server failed (dropped).
    fn sync_labels(&mut self, wanted_gen: u64) -> bool {
        let s = self.s.clone();
        let (labels, labels_hash) = {
            let layout = s.layout.lock();
            (layout.labels.clone(), layout.labels_hash)
        };
        if labels_hash == self.labels_sent || labels.is_empty() {
            return true;
        }
        let mut link = s.link.lock();
        if link.inflight.is_some() {
            return true;
        }
        let srv = self.server.as_mut().unwrap();
        match srv.set_labels(&labels) {
            Ok(()) => {
                self.labels_sent = labels_hash;
                link.labels_sent = labels_hash;
                true
            }
            Err(e) => {
                drop(link);
                s.events
                    .send(Event::EngineState {
                        engine_generation: wanted_gen,
                        state: "Restarting".into(),
                        reason: Some(format!("labels: {e}")),
                    })
                    .ok();
                self.drop_server();
                false
            }
        }
    }

    /// Steps 4, 4b and 5: context, probe, compile frame, under the link lock (released around the
    /// probe compile and every side effect that takes it again).
    fn serve(&mut self, mut req: FastRequest, wanted_gen: u64) {
        let s = self.s.clone();
        let mut link = s.link.lock();
        if !self.ensure_context(&mut link, &mut req, wanted_gen) {
            return;
        }
        if req.probe {
            match self.prove(&mut link, req, wanted_gen) {
                ProbeOutcome::Send(r) => req = r,
                ProbeOutcome::Done => return,
            }
        }
        // 5. the compile frame; the result is collected by step 1
        if !req.warmup && !s.live.lock().unit(req.par_id).cost.begin_trial(Instant::now()) {
            drop(link);
            queue_latest(&s, req);
            return;
        }
        let req_id = link.next_req;
        link.next_req += 1;
        let t0 = Instant::now();
        req.sample_epoch = s.clean_sample_epoch();
        let srv = self.server.as_mut().unwrap();
        match srv.send_compile(req_id, req.seq, &req.source, &req.pics) {
            Ok(()) => {
                link.inflight = Some(InFlight { req, t0 });
            }
            Err(e) => {
                drop(link);
                engine_failed(&s, &req, e, wanted_gen, self.server.as_ref());
                self.drop_server();
            }
        }
    }

    /// Step 4: Send the context when the server does not hold it. False: the iteration is settled
    /// (the context is gone, or the server failed).
    fn ensure_context(
        &mut self,
        link: &mut parking_lot::MutexGuard<'_, EngineLink>,
        req: &mut FastRequest,
        wanted_gen: u64,
    ) -> bool {
        let s = self.s.clone();
        if link.context_rev_sent != req.versions.context_revision {
            link.contexts_sent.clear();
            link.context_rev_sent = req.versions.context_revision;
        }
        if link.contexts_sent.contains(&req.seq) {
            return true;
        }
        let ctx = match req.ctx.take() {
            Some(c) => Some(c),
            None => {
                // built lazily from the current layout; the unit may have a new id there
                let layout = s.layout.lock();
                layout.unit(req.par_id).map(|eu| {
                    req.seq = eu.uid;
                    eu.context_json()
                })
            }
        };
        let Some(ctx) = ctx else {
            parking_lot::MutexGuard::unlocked(link, || {
                s.events
                    .send(Event::BackgroundScheduled {
                        par_id: Some(req.par_id),
                        reasons: vec!["context no longer available".into()],
                        edit_id: req.edit_id,
                    })
                    .ok();
            });
            return false;
        };
        if link.contexts_sent.contains(&req.seq) {
            // the lazy lookup mapped to a context already installed
            return true;
        }
        let srv = self.server.as_mut().unwrap();
        match srv.set_context(req.seq, &ctx) {
            Ok(()) => {
                link.contexts_sent.insert(req.seq);
                true
            }
            Err(e) => {
                parking_lot::MutexGuard::unlocked(link, || {
                    s.events
                        .send(Event::EngineState {
                            engine_generation: wanted_gen,
                            state: "Restarting".into(),
                            reason: Some(format!("set_context: {e}")),
                        })
                        .ok();
                    self.drop_server();
                });
                false
            }
        }
    }

    /// Step 4b: Probe mode: prove the unit first — its snapshot text (from the layout current now)
    /// compiled and compared with that layout's rows. The compile runs without the link lock
    /// (the host's apply_edit must not wait on it); `probing` keeps the direct dispatch path
    /// off the server meanwhile. A verdict is kept for the layout version.
    fn prove(
        &mut self,
        link: &mut parking_lot::MutexGuard<'_, EngineLink>,
        req: FastRequest,
        wanted_gen: u64,
    ) -> ProbeOutcome {
        let s = self.s.clone();
        let (text, lv) = {
            let layout = s.layout.lock();
            (
                layout.snapshot_text(req.par_id).map(|t| t.to_string()),
                layout.layout_version,
            )
        };
        // bound first: a guard in a `match` scrutinee would live through the arms, and the
        // arm that stores the verdict takes the same lock again (a self-deadlock)
        let cached = s.live.lock().probe_for(req.par_id, lv);
        let verdict = match cached {
            Some(v) => v,
            None => {
                let Some(text) = text else {
                    parking_lot::MutexGuard::unlocked(link, || {
                        demote_span(&s, &req, "no snapshot to compare with")
                    });
                    return ProbeOutcome::Done;
                };
                let snapshot_hash = crate::document::hash_str(&text);
                let gate =
                    s.live
                        .lock()
                        .probe_recovery_gate(req.par_id, snapshot_hash, Instant::now());
                match gate {
                    RecoveryGate::Ready => {}
                    RecoveryGate::Wait(_) => {
                        parking_lot::MutexGuard::unlocked(link, || queue_latest(&s, req));
                        return ProbeOutcome::Done;
                    }
                    RecoveryGate::Blocked(why) => {
                        parking_lot::MutexGuard::unlocked(link, || demote_span(&s, &req, why));
                        return ProbeOutcome::Done;
                    }
                }
                link.probing = true;
                let t_probe = Instant::now();
                let srv = self.server.as_mut().unwrap();
                let res = parking_lot::MutexGuard::unlocked(link, || {
                    srv.compile_with_pics(req.seq, &text, &req.pics)
                });
                link.probing = false;
                link.probes += 1;
                link.probe_us += t_probe.elapsed().as_micros() as u64;
                let requeue = |req: FastRequest| queue_latest(&s, req);
                let v = match res {
                    Ok((cr, _))
                        if req.pics_n > 0
                            && cr.pics_seen.is_some_and(|n| n != req.pics_n as i64) =>
                    {
                        // the cache entries were scanned from the current text, the probe
                        // compiles the snapshot's: when they do not pair up the probe is
                        // repeated without them (the pictures are drawn)
                        let mut req = req;
                        req.pics.clear();
                        req.pics_n = 0;
                        parking_lot::MutexGuard::unlocked(link, || requeue(req));
                        return ProbeOutcome::Done;
                    }
                    Ok((cr, _)) if cr.internal.is_some() => ProbeVerdict::Mismatch(format!(
                        "internal error ({})",
                        first_line_of(cr.internal.as_deref().unwrap_or_default())
                    )),
                    Ok((cr, _)) => {
                        if !cr.leaks.is_empty() {
                            ProbeVerdict::Leak(format!(
                                "the unit redefines \\{}",
                                cr.leaks.join(", \\")
                            ))
                        } else if cr.status == "error" {
                            ProbeVerdict::Mismatch(format!(
                                "probe compile failed: {}",
                                cr.errors
                                    .first()
                                    .and_then(|e| e.message.clone())
                                    .unwrap_or_default()
                            ))
                        } else {
                            let layout = s.layout.lock();
                            if layout.layout_version != lv {
                                // the layout moved while the probe ran: judge against the new
                                // one (the request goes back to the queue)
                                drop(layout);
                                parking_lot::MutexGuard::unlocked(link, || requeue(req));
                                return ProbeOutcome::Done;
                            }
                            match &cr.dl {
                                Some(dl) => match layout.probe_check(req.par_id, dl) {
                                    Ok(()) => ProbeVerdict::Verified,
                                    Err(why) => ProbeVerdict::Mismatch(why),
                                },
                                None => ProbeVerdict::Mismatch("probe produced no box".into()),
                            }
                        }
                    }
                    Err(e) => {
                        parking_lot::MutexGuard::unlocked(link, || {
                            engine_failed_from(
                                &s,
                                &req,
                                e,
                                wanted_gen,
                                self.server.as_ref(),
                                Some(snapshot_hash),
                            );
                            self.drop_server();
                        });
                        return ProbeOutcome::Done;
                    }
                };
                s.live.lock().unit(req.par_id).probe = Some((lv, v.clone()));
                v
            }
        };
        match verdict {
            ProbeVerdict::Verified => ProbeOutcome::Send(req),
            ProbeVerdict::Mismatch(why) => {
                parking_lot::MutexGuard::unlocked(link, || demote_span(&s, &req, &why));
                ProbeOutcome::Done
            }
            ProbeVerdict::Leak(why) => {
                parking_lot::MutexGuard::unlocked(link, || {
                    s.live.lock().unit(req.par_id).leak = Some(why.clone());
                    demote_span(&s, &req, &why);
                    // the server's state is no longer the document's: start over
                    s.engine_generation.fetch_add(1, Ordering::SeqCst);
                    self.drop_server();
                });
                ProbeOutcome::Done
            }
        }
    }
}

fn startup_is_current(s: &Shared, generation: u64) -> bool {
    !s.shutdown.load(Ordering::SeqCst) && s.engine_generation.load(Ordering::SeqCst) == generation
}

/// Diagnostic collection can perform slow file I/O. Check again after it, so a failure
/// from an obsolete preamble cannot overwrite the state of an already queued correction.
fn publish_startup_state(
    s: &Shared,
    generation: u64,
    state: &str,
    reason: impl FnOnce() -> Option<String>,
) -> bool {
    if !startup_is_current(s, generation) {
        return false;
    }
    let reason = reason();
    if !startup_is_current(s, generation) {
        return false;
    }
    s.events
        .send(Event::EngineState {
            engine_generation: generation,
            state: state.into(),
            reason,
        })
        .is_ok()
}

/// A fast request the probe (or a leak) took away from the live path after `apply_edit`
/// reported it as fast: undo the live bookkeeping (no overlay claims a result at this
/// revision; the change counts as a background change for the spans after it), tell the host,
/// and schedule the pass that will typeset it.
pub(super) fn demote_span(s: &Shared, req: &FastRequest, why: &str) {
    {
        let files = s.files.lock();
        if let Some((name, line)) = files.iter().find_map(|(name, fb)| {
            fb.span(req.par_id)
                .map(|sp| (name.clone(), fb.line_range(sp).0))
        }) {
            s.bg_change
                .lock()
                .entry(name)
                .or_default()
                .push((req.versions.source_revision, line));
        }
    }
    if !req.warmup {
        s.events
            .send(Event::BackgroundScheduled {
                par_id: Some(req.par_id),
                reasons: vec![format!("unverified: {why}")],
                edit_id: req.edit_id,
            })
            .ok();
    }
    s.need_pass();
}

pub(super) fn engine_failed(
    s: &Shared,
    req: &FastRequest,
    e: anyhow::Error,
    wanted_gen: u64,
    srv: Option<&FastServer>,
) {
    engine_failed_from(s, req, e, wanted_gen, srv, None);
}

fn engine_failed_from(
    s: &Shared,
    req: &FastRequest,
    e: anyhow::Error,
    wanted_gen: u64,
    srv: Option<&FastServer>,
    probe_hash: Option<u64>,
) {
    // The preamble may already have superseded this process while recv waited. Its failure
    // must not consume the new preamble's recovery budget or advance that generation.
    if s.preamble_revision.load(Ordering::SeqCst) > req.versions.source_revision
        || s.engine_generation.load(Ordering::SeqCst) != wanted_gen
    {
        return;
    }
    {
        let mut live = s.live.lock();
        live.unit(req.par_id).cost.cancel_trial(Instant::now());
        live.on_server_replacement();
    }
    let current = {
        let files = s.files.lock();
        let span = files
            .get(&req.source_file)
            .and_then(|fb| fb.span(req.par_id));
        let current = probe_hash.is_none() && span.is_some_and(|sp| sp.hash == req.span_hash);
        if req.warmup || span.is_some() {
            let mut live = s.live.lock();
            if s.preamble_revision.load(Ordering::SeqCst) > req.versions.source_revision
                || s.engine_generation.load(Ordering::SeqCst) != wanted_gen
            {
                return;
            }
            if req.warmup {
                live.unit(req.par_id).warmup_failed = true;
            } else {
                let recovery = live.unit(req.par_id).recovery.get_or_insert_default();
                if let Some(hash) = probe_hash {
                    recovery.failed_probe(hash, Instant::now());
                } else {
                    recovery.failed(req.span_hash, Instant::now());
                }
            }
        }
        current
    };
    // Disable direct dispatch before publishing the restart. If the host managed to send a
    // newer request after recv failed, keep it in the coalescing queue for the new process.
    let stranded = {
        let mut link = s.link.lock();
        link.writer = None;
        link.contexts_sent.clear();
        link.inflight.take()
    };
    if let Some(fl) = stranded {
        s.live.lock().unit(fl.req.par_id).cost.cancel_trial(Instant::now());
        queue_latest(s, fl.req);
    }
    if s.engine_generation
        .compare_exchange(
            wanted_gen,
            wanted_gen + 1,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_err()
    {
        return;
    }
    let mut message = e.to_string();
    if let Some(dir) = debug_bundle(s, req, &message, wanted_gen, srv) {
        message = format!("{message} (debug bundle: {})", dir.display());
    }
    // Bundle I/O can outlive a body or preamble edit. Publish unit diagnostics only while
    // its failed text is still current, under the same files lock used by apply_edit.
    let files = s.files.lock();
    let mut live = s.live.lock();
    if s.preamble_revision.load(Ordering::SeqCst) > req.versions.source_revision
        || s.engine_generation.load(Ordering::SeqCst) != wanted_gen + 1
    {
        return;
    }
    let current = current
        && files
            .get(&req.source_file)
            .and_then(|fb| fb.span(req.par_id))
            .is_some_and(|sp| sp.hash == req.span_hash);
    s.events
        .send(Event::EngineState {
            engine_generation: wanted_gen,
            state: "Restarting".into(),
            reason: Some(message.clone()),
        })
        .ok();
    if current && !req.warmup {
        if let Some(recovery) = live.unit(req.par_id).recovery.as_mut() {
            recovery.reported();
        }
        s.events
            .send(Event::Diagnostics {
                source: format!("fast:{:?}", req.par_id),
                items: vec![Diagnostic {
                    severity: "error".into(),
                    file: None,
                    line: None,
                    message,
                    context: None,
                }],
            })
            .ok();
    }
    if current && !req.warmup {
        s.events
            .send(Event::BackgroundScheduled {
                par_id: Some(req.par_id),
                reasons: vec!["engine restarted".into()],
                edit_id: req.edit_id,
            })
            .ok();
    }
    drop(live);
    drop(files);
    // The same failed text stays off the live path. Changed text may retry, within the
    // per-unit cooldown and budget; old queued generations are rebased by next_request.
    if !req.warmup {
        s.need_pass();
    }
    s.pending_signal.0.send(()).ok();
}

/// The per-compile watchdog. With macro tracing on (`$RTEX_TRACE_MACROS` with a debug
/// directory) every macro expansion is written to the TeX log, which makes a heavy compile (a
/// pgfplots axis drawn) many times slower: the watchdog is lengthened rather than letting the
/// debug setting itself kill the engine.
pub(super) fn compile_timeout(cfg: &SessionConfig) -> Duration {
    if cfg.debug_dir.is_some() && std::env::var_os("RTEX_TRACE_MACROS").is_some_and(|v| v != "0") {
        cfg.compile_timeout * 10
    } else {
        cfg.compile_timeout
    }
}

pub(super) fn handle_result(
    s: &Shared,
    mut req: FastRequest,
    cr: crate::engine::CompileResult,
    rt: crate::engine::RoundTrip,
    t0: Instant,
    wanted_gen: u64,
) {
    record_live_cost(s, &req, t0.elapsed(),
        cr.internal.is_none() && cr.leaks.is_empty() && cr.status != "error" && cr.dl.is_some(),
        wanted_gen);
    if let Some(msg) = cr.internal.as_deref() {
        // the server hit a Lua error of its own on this unit and answered with it (it used to
        // stay silent until the watchdog killed the engine): the unit waits for the pass until
        // the next layout; the engine is fine
        if req.warmup {
            // nothing to demote, and no pass to schedule: a pass would install a layout, which
            // warms the engine again, which would fail again (a loop of passes)
            log::warn!("warm-up compile: internal error in the server: {msg}");
            return;
        }
        let lv = s.layout.lock().layout_version;
        let first = s
            .live
            .lock()
            .unit(req.par_id)
            .internal_error
            .replace((lv, msg.to_string()))
            .is_none_or(|(prev, _)| prev != lv);
        log::warn!("{:?}: internal error in the server: {msg}", req.par_id);
        // one bundle per unit and layout, not one per keystroke
        if first {
            if let Some(dir) =
                debug_bundle(s, &req, &format!("internal error: {msg}"), wanted_gen, None)
            {
                log::warn!("debug bundle: {}", dir.display());
            }
        }
        demote_span(s, &req, &format!("internal error ({})", first_line_of(msg)));
        return;
    }
    if !cr.leaks.is_empty() {
        // before any early return: the compile changed the meaning of a control sequence it
        // mentions, so the server is no longer the document's state whatever else happened.
        // Demote the span until the preamble changes and restart the engine.
        let why = format!("the unit redefines \\{}", cr.leaks.join(", \\"));
        s.live.lock().unit(req.par_id).leak = Some(why.clone());
        demote_span(s, &req, &why);
        s.engine_generation.fetch_add(1, Ordering::SeqCst);
        s.pending_signal.0.send(()).ok();
        return;
    }
    if s.cfg.debug_dir.is_some() {
        debug_request_line(
            s,
            &format!(
                "par {} ctx {} status {} rows {} tex_us {} total_us {} pics {}/{} errors {}{}",
                req.par_id.0,
                req.seq,
                cr.status,
                cr.dl.as_ref().map(|d| d.lines.len()).unwrap_or(0),
                rt.t_tex.as_micros(),
                t0.elapsed().as_micros(),
                cr.pics_used.unwrap_or(0),
                cr.pics_seen.unwrap_or(0),
                cr.errors.len(),
                if req.warmup { " (warm-up)" } else { "" }
            ),
        );
    }
    if req.warmup {
        return;
    }
    // a unit let through unprobed (a borrowed context, or a probe skipped) because every
    // picture in it comes from the cache: when the engine drew one after all (a state
    // mismatch, a picture the scan did not see), the result is unverified and the unit waits
    // for the pass
    if req.pics_required && cr.status != "error" && cr.pics_used != Some(req.pics_n as i64) {
        demote_span(
            s,
            &req,
            "a picture drawn outside the cache on a borrowed context",
        );
        return;
    }
    // the engine saw a different number of picture environments than the source scan (a
    // picture made by a macro, a nested one): its cache entries may have gone to the wrong
    // pictures, so the result is dropped and the compile repeated without them
    if req.pics_n > 0 && cr.pics_seen.is_some_and(|n| n != req.pics_n as i64) {
        log::warn!(
            "{:?}: {} pictures scanned, engine saw {:?}; compiling without the cache",
            req.par_id,
            req.pics_n,
            cr.pics_seen
        );
        let mut again = req;
        again.pics.clear();
        again.pics_n = 0;
        let mut pending = s.pending.lock();
        pending.entry(again.par_id).or_insert(again);
        drop(pending);
        s.pending_signal.0.send(()).ok();
        return;
    }
    // discard rule: the span changed meanwhile, or the generation moved on
    let current_hash = s
        .files
        .lock()
        .values()
        .find_map(|fb| fb.span(req.par_id).map(|sp| sp.hash));
    if current_hash != Some(req.span_hash)
        || s.engine_generation.load(Ordering::SeqCst) != wanted_gen
    {
        return;
    }
    let context_current = {
        let layout = s.layout.lock();
        req.versions.context_revision == layout.context_revision
            && req.versions.layout_version == layout.layout_version
            && !s.semantic_change.lock().as_ref().is_some_and(|change|
                change.revision > layout.snapshot_revision && change.origin != req.par_id)
    };
    if !context_current {
        match refresh_request(s, &req) {
            Some((Some(mut latest), _)) => {
                latest.queued_at = req.queued_at;
                // A borrowed context can survive a stale layout when its complete replay
                // state is identical; only its page anchors need rebasing.
                if req.ctx.is_some() && req.ctx == latest.ctx && req.source == latest.source
                    && req.pics == latest.pics && !latest.probe {
                    req = latest;
                } else {
                    queue_latest(s, latest);
                    return;
                }
            }
            Some((None, reasons)) => {
                demote_span(s, &req, &reasons.join(", "));
                return;
            }
            None => return,
        }
    }
    // the server counts the replay head as line 1: the unit's first source line is line 2, and
    // an error TeX raises at the paragraph's end can name the line after the unit
    let unit_lines = req.source.split('\n').count() as i64;
    let diagnostics: Vec<Diagnostic> = cr
        .errors
        .iter()
        .map(|e| Diagnostic {
            severity: "error".into(),
            file: (!req.source_file.is_empty()).then(|| req.source_file.clone()),
            line: e
                .line
                .map(|l| req.source_first_line + (l - 2).clamp(0, unit_lines)),
            message: e.message.clone().unwrap_or_default(),
            context: e.context.clone(),
        })
        .collect();
    let timing = Timing {
        total_us: t0.elapsed().as_micros() as u64,
        tex_us: rt.t_tex.as_micros() as u64,
        traverse_us: rt.t_traverse.as_micros() as u64,
        pack_us: rt.t_pack.as_micros() as u64,
    };
    if cr.status == "error" || cr.dl.is_none() {
        // an error while typing keeps the unit's last result on screen; one left alone is
        // compiled in full after the settle time, so the layout shows and reports what TeX
        // makes of it (`schedule`)
        s.pass_wish
            .lock()
            .unfinished(req.par_id, Instant::now(), s.cfg.unfinished_settle);
        s.bg_signal.0.send(BgCmd::Pass).ok();
        s.live.lock().unit(req.par_id).live_error = true;
        s.events
            .send(Event::ParagraphUpdate {
                par_id: req.par_id,
                edit_id: req.edit_id,
                versions: req.versions,
                status: "error".into(),
                reasons: vec![],
                fragments: vec![],
                pagination_stale: false,
                context_stale: req.context_stale,
                pass_pending: s.pass_pending(),
                // TeX's recovery from the error is not the paragraph: hosts keep what they drew
                dl: DisplayList::default(),
                diagnostics,
                timing,
            })
            .ok();
        return;
    }
    let mut dl = cr.dl.unwrap();
    {
        let files = s.files.lock();
        crate::layout::normalize_source_anchors(
            &mut dl,
            files.keys().map(String::as_str),
            Some(&s.cfg.project_root),
            Some((
                &req.source_file,
                req.source_first_line,
                req.source.split('\n').count(),
            )),
        );
    }
    if dl.lines.iter().any(|l| !l.source_anchors.is_empty()) {
        dl.source_revision = Some(req.versions.source_revision);
    }
    if !cr.images.is_empty() {
        dl.images = cr.images.clone();
    }
    let rows: Vec<(i64, i64)> = dl.lines.iter().map(|l| (l.x, l.y)).collect();
    let (fragments, mut stale) = {
        let layout = s.layout.lock();
        match layout.fragments(req.par_id, &dl.lines) {
            Some(x) => x,
            None => {
                // a borrowed context: placed relative to the anchor's rows (a layout unit's
                // placements, or the live placement of a unit on a borrowed context itself)
                let derived = s.live.lock().get(req.par_id).and_then(|u| u.derived);
                let frags = derived
                    .and_then(|(parent, anchor, after)| {
                        let placed = s.live.lock().get(anchor).and_then(|u| u.place);
                        match placed.filter(|_| layout.unit(anchor).is_none()) {
                            Some((page, x, last)) => {
                                let bs = layout.unit(parent)?.baselineskip().max(1);
                                Some(LayoutStore::fragments_at(page, x, last + bs, &rows))
                            }
                            None => {
                                // a layout unit, or a chained unit not delivered (yet)
                                let a = if layout.unit(anchor).is_some() {
                                    anchor
                                } else {
                                    parent
                                };
                                let live = s.live.lock().get(a).and_then(|u| u.rows);
                                layout.fragments_relative(a, live, after, &rows)
                            }
                        }
                    })
                    .unwrap_or_default();
                (frags, true)
            }
        }
    };
    // a placement that lands off its page is a bad guess (a borrowed anchor on another page,
    // a unit grown past the page bottom, rows extrapolated above the top): drop it so the unit
    // waits for the pass instead of drawing its rows, pictures and all, at the page edge or
    // past it (two graphs, a plot pinned to the page top)
    if !fragments.is_empty() && !s.layout.lock().fragments_on_page(&fragments) {
        demote_span(s, &req, "the placement would fall off its page");
        return;
    }
    // a box the host cannot place (no placement for the unit, no neighbour to place it
    // against) is not a live result: the unit waits for the pass
    if fragments.is_empty() && !dl.lines.is_empty() {
        demote_span(s, &req, "no placement for the unit's rows");
        return;
    }
    let clearance = {
        let files = s.files.lock();
        let layout = s.layout.lock();
        let live = s.live.lock();
        let current: HashSet<_> = files.values().flat_map(|fb| fb.spans.iter().map(|sp| sp.id)).collect();
        let mut ignored = HashSet::new();
        let mut other_live = Vec::new();
        for unit in &layout.units {
            if unit.span.is_some_and(|id| !current.contains(&id)
                || (id != req.par_id && !unit.captured.placements.is_empty() && live.get(id).and_then(|u| u.painted.as_ref())
                    .is_some_and(|painted| painted.layout_version == layout.layout_version))) {
                ignored.extend(unit.uids.iter().copied());
            }
        }
        let mut unknown_retained_ink = false;
        for id in current.into_iter().filter(|id| *id != req.par_id) {
            if let Some(painted) = live.get(id).and_then(|u| u.painted.as_ref()) {
                unknown_retained_ink |= painted.layout_version != layout.layout_version;
                other_live.extend(painted.ink.iter().copied());
            }
        }
        !unknown_retained_ink && layout.live_rows_fit(req.par_id, &dl, &fragments, &ignored, &other_live)
    };
    if !clearance {
        demote_span(s, &req, "the new row boxes have no verified clearance from the page or neighboring content");
        return;
    }
    if s.cfg.debug_dir.is_some() {
        let f = fragments.first();
        debug_request_line(
            s,
            &format!(
                "par {} placed: rows {} fragments {} page {:?} x {:?} y {:?}..{:?} approximate {:?}",
                req.par_id.0,
                dl.lines.len(),
                fragments.len(),
                f.map(|f| f.page),
                f.and_then(|f| f.xs.first().copied()),
                f.and_then(|f| f.baselines.first().copied()),
                fragments.last().and_then(|f| f.baselines.last().copied()),
                f.map(|f| f.approximate),
            ),
        );
    }
    // a structure closed live ends its settle window (`PassWish::completed`)
    s.pass_wish.lock().completed();
    {
        let mut live = s.live.lock();
        let u = live.unit(req.par_id);
        if u.recovery.as_mut().is_some_and(CrashRecovery::succeeded) {
            s.events
                .send(Event::Diagnostics {
                    source: format!("fast:{:?}", req.par_id),
                    items: vec![],
                })
                .ok();
        }
        u.live_error = false;
        u.rows = Some(dl.lines.len() as i64);
        u.painted = PaintedRows::new(req.versions.layout_version, req.versions.source_revision, &dl, &fragments);
        if let Some(f) = fragments.last() {
            if let (Some(x), Some(last)) = (f.xs.first(), f.baselines.last()) {
                u.place = Some((f.page, *x, *last));
            }
        }
    }
    if req.expected_rows != dl.lines.len() as i64 {
        stale = true;
    }
    stale |= s.layout.lock().geometry_changed(req.par_id, &dl);
    let mut reasons: Vec<String> = dl.flags_map().keys().cloned().collect();
    if dl.inserts > 0 {
        // footnote/margin text is placed by the page builder: refreshed by the next layout
        reasons.push("inserts".into());
    }
    // counters: a unit that now advances other counters, or to other values, than the layout
    // saw (an added equation, item, footnote or \stepcounter) renumbers what follows: pass
    let counters_changed = {
        let expected = s
            .layout
            .lock()
            .unit(req.par_id)
            .map(|u| u.advanced())
            .unwrap_or_default();
        let prev = s
            .live
            .lock()
            .unit(req.par_id)
            .counters
            .replace(cr.counters.clone())
            .unwrap_or(expected);
        prev != cr.counters
    };
    if counters_changed {
        s.note_semantic_change(req.versions.source_revision, req.par_id, true);
    }
    // a layout that rendered or reported this unit wrongly (TeX errors in it, or a structure
    // that was still being typed when it was compiled) is corrected by a pass now that the unit
    // compiles cleanly
    let corrects_layout = {
        let mut layout = s.layout.lock();
        // an error the layout could not place (or a pass that failed): one pass, not one per
        // keystroke, until a layout is installed again
        std::mem::take(&mut layout.unsettled_any) || layout.unsettled.contains(&req.par_id)
    };
    if stale || counters_changed || !reasons.is_empty() || corrects_layout {
        s.need_pass();
    }
    s.events
        .send(Event::ParagraphUpdate {
            par_id: req.par_id,
            edit_id: req.edit_id,
            versions: req.versions,
            status: if reasons.is_empty() {
                "ok".into()
            } else {
                "ok_degraded".into()
            },
            reasons,
            fragments,
            pagination_stale: stale,
            context_stale: req.context_stale,
            pass_pending: s.pass_pending(),
            dl,
            diagnostics,
            timing,
        })
        .ok();
}

/// Obsolete source still consumed the server; publication validity is checked separately.
fn record_live_cost(s: &Shared, req: &FastRequest, service: Duration, clean: bool, generation: u64) {
    if req.warmup || s.engine_generation.load(Ordering::SeqCst) != generation { return }
    let now = Instant::now();
    let full = s.full_latency(now);
    let queued: Vec<_> = s.pending.lock().values()
        .filter(|other| !other.warmup && other.par_id != req.par_id)
        .map(|other| (other.par_id, other.queued_at)).collect();
    let blocked = queued.iter().any(|(_, at)|
        now.saturating_duration_since(*at) >= s.cfg.fast_budget);
    let uncontended = req.sample_epoch == Some(s.bg_epoch.load(Ordering::SeqCst))
        && !s.bg_running.load(Ordering::SeqCst);
    let mut live = s.live.lock();
    let queued_work = queued.iter().filter_map(|(id, _)| live.get(*id)?.cost.estimate())
        .fold(Duration::ZERO, |sum, value| sum.saturating_add(value));
    let already_waited = now.saturating_duration_since(req.queued_at).saturating_sub(service);
    // Keep warm service samples separate while comparing complete observed turnaround.
    let competing = full.map(|total| total.saturating_sub(already_waited.saturating_add(queued_work)));
    let unit = live.unit(req.par_id);
    if !clean || !uncontended {
        unit.cost.cancel_trial(now);
        return;
    }
    if !std::mem::replace(&mut unit.measured_once, true) {
        unit.cost.cancel_trial(now);
        return;
    }
    unit.cost.record(service, s.cfg.fast_budget, competing, blocked, now);
    let deferred = !unit.cost.allows(now);
    drop(live);
    if deferred {
        s.need_pass();
        s.events.send(Event::BackgroundScheduled {
            par_id: Some(req.par_id), edit_id: req.edit_id,
            reasons: vec![reason_str(&Reason::OverBudget(service.as_millis() as u64))],
        }).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session with no worker threads or processes: these tests exercise the real failure,
    /// queue and result handlers, with a synthetic document and an explicit clock.
    fn fixture() -> (Shared, Receiver<Event>, ParaId) {
        let mut ids = IdAllocator(0);
        let file = FileBuf::new(
            "\\begin{document}\nOriginal math.\n\nOther paragraph.\n\\end{document}\n",
            &mut ids,
            1,
        );
        let id = file
            .spans
            .iter()
            .find(|sp| sp.kind == SpanKind::Body)
            .unwrap()
            .id;
        let (tx, rx) = unbounded();
        let mut cfg = SessionConfig::new(".", "main.tex");
        cfg.debug_dir = None;
        let shared = Shared {
            link: Mutex::new(EngineLink::default()),
            files: Mutex::new(BTreeMap::from([("main.tex".into(), file)])),
            ids: Mutex::new(ids),
            source_revision: AtomicU64::new(1),
            preamble_revision: AtomicU64::new(1),
            bg_change: Mutex::new(HashMap::new()),
            semantic_change: Mutex::new(None),
            layout: Mutex::new(LayoutStore::default()),
            engine_generation: AtomicU64::new(0),
            events: tx,
            pending: Mutex::new(BTreeMap::new()),
            pending_signal: unbounded(),
            bg_signal: unbounded(),
            pass_wish: Mutex::new(PassWish::default()),
            shutdown: AtomicBool::new(false),
            bg_running: AtomicBool::new(false),
            bg_epoch: AtomicU64::new(0),
            full_cost: Mutex::new(Samples::default()),
            bg_paused: AtomicBool::new(false),
            bg_pending_while_paused: AtomicBool::new(false),
            cfg,
            tl: TexLive {
                bin_dir: None,
                lualatex: PathBuf::new(),
                rtex_texdir: PathBuf::new(),
            },
            policy: Mutex::new(Policy::from_preamble("", &[], &[])),
            preamble_inputs: Mutex::new(Default::default()),
            inputted: Mutex::new(Default::default()),
            edit_counter: AtomicU64::new(0),
            convergence: Mutex::new(None),
            live: Mutex::new(LiveUnits::default()),
            standby: Mutex::new(None),
            last_pass_dir: Mutex::new(None),
            pic_index: Mutex::new(None),
            pic_scan: Mutex::new(None),
        };
        (shared, rx, id)
    }

    #[test]
    fn missing_inputs_are_not_fabricated_as_empty_snapshot_files() {
        let (s, rx, _) = fixture();
        let session = Session { shared: Arc::new(s), events: rx,
            requeued: Mutex::new(Default::default()), threads: vec![] };
        session.set_document("main.tex", "\\begin{document}\n\\input{nonexistent-audit-chapter}\n\\end{document}").unwrap();
        assert!(!snapshot(&session.shared).0.contains_key("nonexistent-audit-chapter.tex"));
    }

    #[test]
    fn removing_an_input_drops_its_snapshot_and_allows_recreation() {
        let (s, rx, _) = fixture();
        let session = Session { shared: Arc::new(s), events: rx,
            requeued: Mutex::new(Default::default()), threads: vec![] };
        session.set_document("chapter.tex", "Unsaved chapter.").unwrap();
        let before = session.versions().source_revision;
        let result = session.remove_document("chapter.tex");
        assert!(result.source_revision > before);
        assert!(!snapshot(&session.shared).0.contains_key("chapter.tex"));
        assert!(!result.outcome.removed.is_empty());
        assert!(session.spans("chapter.tex").is_empty());
        assert!(session.document_text("main.tex").unwrap().contains("Original math."));
        assert_eq!(session.remove_document("chapter.tex").source_revision, result.source_revision);
        session.set_document("chapter.tex", "Recreated chapter.").unwrap();
        assert_eq!(snapshot(&session.shared).0["chapter.tex"], "Recreated chapter.");
    }

    #[test]
    fn a_missing_or_restored_preamble_input_rebuilds_the_live_policy() {
        let (s, rx, _) = fixture();
        let session = Session { shared: Arc::new(s), events: rx, requeued: Mutex::new(Default::default()), threads: vec![] };
        session.set_document("main.tex", "\\documentclass{article}\n\\input{audit-definitions}\n\\begin{document}\n\\begin{auditlemma}Body.\\end{auditlemma}\n\\end{document}").unwrap();
        for _ in 0..2 {
            let generation = session.shared.engine_generation.load(Ordering::SeqCst);
            let added = session.set_document("audit-definitions.tex", "\\newtheorem{auditlemma}{Lemma}\n").unwrap();
            assert_eq!(added.routed, "preamble");
            assert!(session.shared.engine_generation.load(Ordering::SeqCst) > generation);
            assert!(session.shared.policy.lock().theorem_envs.contains("auditlemma"));
            assert!(session.shared.preamble_inputs.lock().contains("audit-definitions.tex"));
            assert!(session.shared.files.lock()["main.tex"].extra_block_envs.contains(&"auditlemma".to_string()));
            session.remove_document("audit-definitions.tex");
            assert!(!session.shared.policy.lock().theorem_envs.contains("auditlemma"));
        }
    }

    #[test]
    fn an_edit_cannot_advance_the_revision_while_a_snapshot_holds_the_files() {
        let (s, rx, id) = fixture();
        let session = Session {
            shared: Arc::new(s),
            events: rx,
            requeued: Mutex::new(Default::default()),
            threads: vec![],
        };
        let files = session.shared.files.lock();
        let at = files["main.tex"].span(id).unwrap().range.start;
        let observed = std::thread::scope(|scope| {
            let edit = scope.spawn(|| {
                session
                    .apply_edit("main.tex", Edit {
                        start_byte: at,
                        end_byte: at,
                        text: "Edited ".into(),
                    })
                    .unwrap()
            });
            let deadline = Instant::now() + Duration::from_secs(2);
            while session.shared.edit_counter.load(Ordering::SeqCst) == 0
                && Instant::now() < deadline
            {
                std::thread::yield_now();
            }
            let started = session.shared.edit_counter.load(Ordering::SeqCst) != 0;
            let deadline = Instant::now() + Duration::from_millis(100);
            while session.shared.source_revision.load(Ordering::SeqCst) == 1
                && Instant::now() < deadline
            {
                std::thread::yield_now();
            }
            let observed = session.shared.source_revision.load(Ordering::SeqCst);
            drop(files);
            let result = edit.join().unwrap();
            assert!(started, "the edit must reach its files-lock boundary");
            assert_eq!(result.source_revision, 2);
            observed
        });
        assert_eq!(observed, 1, "old source must retain its old snapshot revision");
        let (texts, _, rev) = snapshot(&session.shared);
        assert_eq!(rev, 2);
        assert!(texts["main.tex"].contains("Edited Original math."));
    }

    #[test]
    fn a_new_file_revision_is_not_visible_to_a_snapshot_before_the_file() {
        let (s, rx, _) = fixture();
        let session = Session {
            shared: Arc::new(s),
            events: rx,
            requeued: Mutex::new(Default::default()),
            threads: vec![],
        };
        // Pause span allocation after the revision has been assigned.
        let ids = session.shared.ids.lock();
        let (advanced, exposed) = std::thread::scope(|scope| {
            let insert = scope.spawn(|| session.set_document("new.tex", "New file.\n").unwrap());
            let deadline = Instant::now() + Duration::from_secs(2);
            while session.shared.source_revision.load(Ordering::SeqCst) == 1
                && Instant::now() < deadline
            {
                std::thread::yield_now();
            }
            let advanced = session.shared.source_revision.load(Ordering::SeqCst) == 2;
            let exposed = session
                .shared
                .files
                .try_lock_for(Duration::from_millis(100))
                .is_some();
            drop(ids);
            assert_eq!(insert.join().unwrap().source_revision, 2);
            (advanced, exposed)
        });
        assert!(advanced, "the insertion must reach span allocation");
        assert!(
            !exposed,
            "a snapshot must not observe a revision whose new file is missing"
        );
        let (texts, _, rev) = snapshot(&session.shared);
        assert_eq!(rev, 2);
        assert_eq!(texts["new.tex"], "New file.\n");
    }

    #[test]
    fn a_preamble_fix_during_startup_diagnostics_suppresses_the_obsolete_failure() {
        let (s, rx, _) = fixture();
        assert!(!publish_startup_state(&s, 0, "Failed", || {
            // This is the deterministic boundary at which a real debug-bundle write can
            // outlive a user correction. The event must be checked after that work too.
            s.engine_generation.store(1, Ordering::SeqCst);
            Some("the previous preamble failed".into())
        }));
        assert!(rx.try_iter().next().is_none());
        assert!(!publish_startup_state(&s, 0, "Failed", || {
            panic!("an already obsolete startup must not collect a debug bundle")
        }));
        assert!(!publish_startup_state(&s, 0, "Ready", || None));
        assert!(publish_startup_state(&s, 1, "Ready", || None));
        let events: Vec<_> = rx.try_iter().collect();
        assert!(
            matches!(events.as_slice(), [Event::EngineState { engine_generation: 1, state, reason: None }] if state == "Ready")
        );

        s.shutdown.store(true, Ordering::SeqCst);
        assert!(!publish_startup_state(&s, 1, "Failed", || {
            panic!("a closed session must not publish a late startup failure")
        }));
        assert!(rx.try_iter().next().is_none());
    }

    #[test]
    fn body_edits_wait_for_contexts_from_the_current_preamble_then_resume_live() {
        let (s, rx, id) = fixture();
        {
            let mut layout = s.layout.lock();
            layout.layout_version = 1;
            layout.snapshot_revision = 1;
            layout.by_span.insert(id, 0);
            layout.units = vec![EngineUnit {
                uid: id.0 as i64,
                captured: crate::capture::CapturedUnit {
                    kind: "par".into(),
                    placements: vec![Default::default()],
                    ..Default::default()
                },
                first_para: Some(crate::capture::CapturedParagraph {
                    begin: Some(Default::default()),
                    ..Default::default()
                }),
                flags: Default::default(),
                members: vec![],
                span: Some(id),
                uids: vec![id.0 as i64],
            }];
        }
        let session = Session {
            shared: Arc::new(s),
            events: rx,
            requeued: Mutex::new(Default::default()),
            threads: vec![],
        };
        let edit_body = |session: &Session| {
            let at = session
                .document_text("main.tex")
                .unwrap()
                .find("Original")
                .unwrap()
                + "Original".len();
            session
                .apply_edit(
                    "main.tex",
                    Edit {
                        start_byte: at,
                        end_byte: at,
                        text: "x".into(),
                    },
                )
                .unwrap()
        };
        assert_eq!(edit_body(&session).routed, "fast");
        let broken = session
            .apply_edit(
                "main.tex",
                Edit {
                    start_byte: 0,
                    end_byte: 0,
                    text: "\\stop\n".into(),
                },
            )
            .unwrap();
        assert_eq!(broken.routed, "preamble");

        // Model a preamble pass that failed: it deliberately retains the previous layout.
        // A body edit must schedule another full pass rather than queueing a live request
        // that can never start on the bad preamble.
        let changed = edit_body(&session);
        assert_eq!(changed.routed, "background", "{:?}", changed.reasons);
        assert!(changed
            .reasons
            .iter()
            .any(|r| r.contains("preamble context is not ready")));
        assert!(!session.shared.pending.lock().contains_key(&id));
        assert!(session.events.try_iter().any(|event| matches!(event,
            Event::BackgroundScheduled { par_id: Some(par_id), edit_id, .. }
                if par_id == id && edit_id == changed.edit_id)));

        let fixed = session
            .apply_edit(
                "main.tex",
                Edit {
                    start_byte: 0,
                    end_byte: "\\stop\n".len(),
                    text: String::new(),
                },
            )
            .unwrap();
        assert_eq!(fixed.routed, "preamble");
        assert_eq!(
            edit_body(&session).routed,
            "background",
            "correcting the preamble still needs a fresh matching layout"
        );
        {
            // The next successful full compile captures contexts for the corrected preamble.
            let mut layout = session.shared.layout.lock();
            layout.snapshot_revision = session.shared.source_revision.load(Ordering::SeqCst);
            layout.layout_version += 1;
            layout.context_revision += 1;
        }
        assert_eq!(edit_body(&session).routed, "fast");

        let at = session
            .document_text("main.tex")
            .unwrap()
            .find("\n\nOther")
            .unwrap();
        let split = session
            .apply_edit(
                "main.tex",
                Edit {
                    start_byte: at,
                    end_byte: at,
                    text: "\n\nNew mathematics.".into(),
                },
            )
            .unwrap();
        assert_eq!(split.routed, "fast", "{:?}", split.reasons);
        assert!(!split.outcome.added.is_empty());
        assert!(
            split.outcome.added.iter().all(|added| session
                .shared
                .pending
                .lock()
                .get(added)
                .is_some_and(|request| request.ctx.is_some())),
            "new paragraphs may borrow a context when the preamble is unchanged"
        );
    }

    fn request(s: &Shared, id: ParaId) -> FastRequest {
        let files = s.files.lock();
        let fb = &files["main.tex"];
        let span = fb.span(id).unwrap();
        let rev = s.source_revision.load(Ordering::SeqCst);
        let layout = s.layout.lock();
        FastRequest {
            queued_at: Instant::now(),
            sample_epoch: None,
            warmup: false,
            par_id: id,
            edit_id: rev,
            span_hash: span.hash,
            source: fb.span_text(id).unwrap().into(),
            source_file: "main.tex".into(),
            source_first_line: fb.line_range(span).0,
            pics: String::new(),
            pics_n: 0,
            seq: id.0 as i64,
            ctx: None,
            versions: Versions {
                source_revision: rev,
                engine_generation: s.engine_generation.load(Ordering::SeqCst),
                context_revision: layout.context_revision,
                layout_version: layout.layout_version,
            },
            context_stale: false,
            expected_rows: 0,
            probe: false,
            pics_required: false,
        }
    }

    fn replace(s: &Shared, id: ParaId, text: &str) {
        let mut files = s.files.lock();
        let fb = files.get_mut("main.tex").unwrap();
        let range = fb.span(id).unwrap().range.clone();
        let rev = s.source_revision.fetch_add(1, Ordering::SeqCst) + 1;
        fb.apply(
            &Edit {
                start_byte: range.start,
                end_byte: range.end,
                text: text.into(),
            },
            &mut s.ids.lock(),
            rev,
        );
        assert!(fb.span(id).is_some());
    }

    fn warmup(s: &Shared, id: ParaId) -> FastRequest {
        let mut req = request(s, id);
        let mut layout = s.layout.lock();
        layout.layout_version = 5;
        layout.snapshot_revision = 1;
        layout.context_revision = 7;
        layout.by_span.insert(id, 0);
        layout.units = vec![EngineUnit {
            uid: id.0 as i64,
            captured: Default::default(),
            first_para: None,
            flags: Default::default(),
            members: vec![],
            span: Some(id),
            uids: vec![id.0 as i64],
        }];
        req.warmup = true;
        req.edit_id = 0;
        req.source_file.clear();
        req.span_hash = 0;
        req.versions.layout_version = layout.layout_version;
        req.versions.context_revision = layout.context_revision;
        req
    }

    #[test]
    fn a_stale_layout_preserves_the_placement_of_a_new_paragraph_in_flight() {
        let (s, rx, parent) = fixture();
        warmup(&s, parent);
        {
            let mut layout = s.layout.lock();
            let eu = &mut layout.units[0];
            eu.captured.kind = "par".into();
            eu.captured.placements = vec![crate::capture::Placement {
                page: 1,
                x: 40,
                y: 100,
                ..Default::default()
            }];
            eu.first_para = Some(crate::capture::CapturedParagraph {
                begin: Some(Default::default()),
                ..Default::default()
            });
        }
        let session = Session {
            shared: Arc::new(s),
            events: rx,
            requeued: Mutex::new(Default::default()),
            threads: vec![],
        };
        let at = session
            .document_text("main.tex")
            .unwrap()
            .find("Other paragraph.")
            .unwrap();
        session
            .apply_edit(
                "main.tex",
                Edit {
                    start_byte: at,
                    end_byte: at,
                    text: "Fresh body.\n\n".into(),
                },
            )
            .unwrap();
        let fresh = {
            let files = session.shared.files.lock();
            let fb = &files["main.tex"];
            fb.spans
                .iter()
                .find(|sp| fb.text[sp.range.clone()].contains("Fresh body."))
                .unwrap()
                .id
        };
        let req = session
            .shared
            .pending
            .lock()
            .remove(&fresh)
            .expect("fresh body goes live");
        assert!(session.shared.layout.lock().unit(fresh).is_none());
        assert!(session.shared.live.lock().is_derived(fresh));
        {
            let mut live = session.shared.live.lock();
            let u = live.unit(fresh);
            u.rows = Some(9);
            u.place = Some((2, 80, 900));
        }

        // A pass started before the insertion finishes while this live compile is in flight.
        {
            let files = session.shared.files.lock();
            let current = files
                .values()
                .flat_map(|fb| fb.spans.iter().map(|sp| sp.id))
                .collect();
            let mut layout = session.shared.layout.lock();
            layout.layout_version = 6;
            layout.context_revision += 1;
            layout.units[0].captured.placements[0].y = 200;
            session
                .shared
                .live
                .lock()
                .on_new_layout(&layout, &current, &HashSet::new());
        }
        let mut result: crate::engine::CompileResult =
            serde_json::from_value(serde_json::json!({ "req": 1, "status": "ok" })).unwrap();
        result.dl = Some(DisplayList {
            lines: vec![rtex_dl::Line::default()],
            ..Default::default()
        });
        handle_result(
            &session.shared,
            req,
            result,
            Default::default(),
            Instant::now(),
            0,
        );
        let events: Vec<_> = session.events.try_iter().collect();
        assert!(events.iter().any(|event| matches!(event,
            Event::ParagraphUpdate { par_id, status, fragments, .. }
                if *par_id == fresh && status == "ok" && fragments.len() == 1
                    && fragments[0].page == 1 && fragments[0].baselines == [201]
        )), "a stale pass must not suppress a newer paragraph's live update: {events:?}");
    }

    #[test]
    fn retained_newer_painted_ink_reanchors_without_blocking_independent_content() {
        const PT: i64 = 65536;
        // A moves onto B, onto a different page, or loses its anchor (the preview keeps it).
        for anchor_page in [Some(1), Some(2), None] {
            let (s, rx, first) = fixture();
            warmup(&s, first);
            let second = s.files.lock()["main.tex"].spans.iter()
                .find(|sp| sp.kind == SpanKind::Body && sp.id != first).unwrap().id;
            replace(&s, first, "Edited original math.\n\n");
            let newer_revision = s.source_revision.load(Ordering::SeqCst);
            let current = HashSet::from([first, second]);
            let dl = DisplayList { lines: vec![rtex_dl::Line {
                w: 20 * PT, h: 10 * PT, ..Default::default()
            }], ..Default::default() };
            {
                let mut layout = s.layout.lock();
                layout.units[0].captured.kind = "par".into();
                layout.units[0].captured.placements = vec![crate::capture::Placement {
                    page: 1, row: 1, x: 40 * PT, y: 60 * PT, ..Default::default()
                }];
                let mut other = layout.units[0].clone();
                other.uid = second.0 as i64;
                other.uids = vec![other.uid];
                other.span = Some(second);
                other.captured.placements[0].y = 100 * PT;
                layout.by_span.insert(second, 1);
                layout.units.push(other);
                for page in [1, 2] { layout.pages.insert(page, DisplayList {
                    page_width: Some(200 * PT), page_height: Some(200 * PT), ..Default::default()
                }); }
                let frags = layout.fragments(first, &[rtex_dl::Line::default()]).unwrap().0;
                s.live.lock().unit(first).painted = PaintedRows::new(layout.layout_version, newer_revision, &dl, &frags);
                if let Some(page) = anchor_page {
                    layout.units[0].captured.placements[0].page = page;
                    layout.units[0].captured.placements[0].y = 100 * PT;
                } else {
                    layout.units[0].captured.placements.clear();
                }
                layout.layout_version += 1;
                layout.context_revision += 1;
                s.live.lock().on_new_layout(&layout, &current, &HashSet::new());
                let live = s.live.lock();
                let painted = live.get(first).unwrap().painted.as_ref().unwrap();
                assert_eq!(painted.layout_version, layout.layout_version);
                assert_eq!(painted.ink[0].page, anchor_page.unwrap_or(1));
                assert_eq!(painted.ink[0].bottom, if anchor_page.is_some() { 100 * PT } else { 60 * PT });
            }
            let mut result: crate::engine::CompileResult =
                serde_json::from_value(serde_json::json!({"req": 1, "status": "ok"})).unwrap();
            result.dl = Some(dl);
            let mut req = request(&s, second);
            req.expected_rows = 1;
            handle_result(&s, req, result, Default::default(), Instant::now(), 0);
            let events: Vec<_> = rx.try_iter().collect();
            let published = events.iter().any(|event| matches!(event,
                Event::ParagraphUpdate { par_id, status, .. } if *par_id == second && status == "ok"));
            assert_eq!(published, anchor_page != Some(1), "only overlapping retained ink blocks B: {events:?}");
            if !published {
                assert!(events.iter().any(|event| matches!(event,
                    Event::BackgroundScheduled { par_id: Some(id), reasons, .. }
                        if *id == second && reasons.iter().any(|reason| reason.contains("clearance")))));
            }
        }
    }

    #[test]
    fn warmups_use_their_layout_context_and_source_unit_instead_of_a_source_hash() {
        let (s, _, id) = fixture();
        let req = warmup(&s, id);
        assert_eq!(req.span_hash, 0);
        s.pending.lock().insert(id, req);
        assert!(take_ready_request(&s, 0, Instant::now()).0.unwrap().warmup);

        let req = warmup(&s, id);
        s.preamble_revision.store(2, Ordering::SeqCst);
        // A stale pass can finish after the preamble changed and queue a warm-up bearing
        // the current engine generation; its old snapshot still cannot provide a context.
        s.pending.lock().insert(id, req);
        assert!(take_ready_request(&s, 0, Instant::now()).0.is_none());
        s.preamble_revision.store(1, Ordering::SeqCst);

        let req = warmup(&s, id);
        s.layout.lock().context_revision += 1;
        s.pending.lock().insert(id, req);
        assert!(take_ready_request(&s, 0, Instant::now()).0.is_none());

        let req = warmup(&s, id);
        s.layout.lock().layout_version += 1;
        s.pending.lock().insert(id, req);
        assert!(take_ready_request(&s, 0, Instant::now()).0.is_none());

        let req = warmup(&s, id);
        replace(&s, id, "Edited after warm-up was queued.\n");
        s.pending.lock().insert(id, req);
        assert!(take_ready_request(&s, 0, Instant::now()).0.is_none());
    }

    #[test]
    fn a_failed_warmup_restarts_without_a_pass_loop_or_using_the_real_edit_budget() {
        let (s, _, id) = fixture();
        let req = warmup(&s, id);
        engine_failed(&s, &req, anyhow!("synthetic warm-up crash"), 0, None);
        assert_eq!(s.engine_generation.load(Ordering::SeqCst), 1);
        assert!(
            !s.pass_pending(),
            "a pass would repeat the speculative warm-up"
        );
        assert!(s.bg_signal.1.try_recv().is_err());
        assert!(s.live.lock().get(id).unwrap().warmup_failed);
        assert!(s.live.lock().get(id).unwrap().recovery.is_none());
        s.pending.lock().insert(id, warmup(&s, id));
        assert!(take_ready_request(&s, 1, Instant::now()).0.is_none());
        let real = request(&s, id);
        assert!(s
            .live
            .lock()
            .recovery_ready(id, real.span_hash, Instant::now()));
        s.live.lock().on_preamble_change();
        s.pending.lock().insert(id, warmup(&s, id));
        assert!(take_ready_request(&s, 1, Instant::now()).0.is_some());
    }

    #[test]
    fn stale_failure_preserves_a_queued_fix_for_the_fresh_generation() {
        let (s, rx, id) = fixture();
        let failed = request(&s, id);
        replace(&s, id, "Fixed math.\n");
        s.pending.lock().insert(id, request(&s, id));
        engine_failed(&s, &failed, anyhow!("synthetic crash"), 0, None);
        assert_eq!(s.engine_generation.load(Ordering::SeqCst), 1);
        assert!(
            rx.try_iter().all(|event| !matches!(
                event,
                Event::Diagnostics { .. } | Event::BackgroundScheduled { .. }
            )),
            "obsolete source must not report a current paragraph failure"
        );
        let now = Instant::now();
        let (req, wait) = take_ready_request(&s, 1, now);
        assert!(req.is_none() && wait.is_some());
        let (req, _) = take_ready_request(&s, 1, now + Duration::from_secs(2));
        let req = req.expect("the already queued correction must survive the restart");
        assert_eq!(req.source, "Fixed math.\n");
        assert_eq!(req.versions.engine_generation, 1);
        assert_ne!(req.span_hash, failed.span_hash);
        assert!(matches!(
            s.live.lock().recovery_gate(id, failed.span_hash, now),
            RecoveryGate::Blocked(_)
        ));
    }

    #[test]
    fn an_old_probe_snapshot_failure_does_not_mark_the_current_correction_as_crashed() {
        let (s, rx, id) = fixture();
        let snapshot_hash =
            crate::document::hash_str("Old snapshot that crashes only in a live context.");
        replace(&s, id, "Corrected current source.\n");
        let req = request(&s, id);
        engine_failed_from(
            &s,
            &req,
            anyhow!("snapshot crashed"),
            0,
            None,
            Some(snapshot_hash),
        );
        let later = Instant::now() + Duration::from_secs(60);
        let live = s.live.lock();
        assert_eq!(
            live.recovery_gate(id, req.span_hash, later),
            RecoveryGate::Ready
        );
        assert!(matches!(
            live.probe_recovery_gate(id, snapshot_hash, later),
            RecoveryGate::Blocked(_)
        ));
        assert_eq!(
            live.probe_recovery_gate(id, snapshot_hash + 1, later),
            RecoveryGate::Ready
        );
        drop(live);
        assert!(rx.try_iter().all(|event| !matches!(
            event,
            Event::Diagnostics { .. } | Event::BackgroundScheduled { .. }
        )));
        let mut layout = LayoutStore::default();
        layout.layout_version = 10;
        s.live.lock().on_new_layout(&layout, &HashSet::new(), &HashSet::new());
        assert!(
            matches!(
                s.live.lock().probe_recovery_gate(id, snapshot_hash, later),
                RecoveryGate::Blocked(_)
            ),
            "installing identical snapshot text again must not repeat its crash"
        );
    }

    #[test]
    fn a_probe_or_startup_requeue_cannot_overwrite_a_newer_correction() {
        let (s, _, id) = fixture();
        let older = request(&s, id);
        replace(&s, id, "Newest correction.\n");
        queue_latest(&s, request(&s, id));
        queue_latest(&s, older);
        let (req, _) = take_ready_request(&s, 0, Instant::now());
        assert_eq!(req.unwrap().source, "Newest correction.\n");

        // A genuine correction supersedes a still-queued speculative warm-up too.
        queue_latest(&s, warmup(&s, id));
        queue_latest(&s, request(&s, id));
        assert!(!take_ready_request(&s, 0, Instant::now()).0.unwrap().warmup);
    }

    #[test]
    fn newest_real_edit_precedes_an_older_unit() {
        let (s, _, first) = fixture();
        let second = s.files.lock()["main.tex"].spans.iter()
            .find(|sp| sp.kind == SpanKind::Body && sp.id != first).unwrap().id;
        let older = request(&s, first);
        let mut newer = request(&s, second);
        newer.edit_id = older.edit_id + 1;
        queue_latest(&s, older);
        queue_latest(&s, newer);
        assert_eq!(take_ready_request(&s, 0, Instant::now()).0.unwrap().par_id, second);
    }

    #[test]
    fn newest_real_edit_precedes_a_font_warmup() {
        let (s, _, first) = fixture();
        let second = s.files.lock()["main.tex"].spans.iter()
            .find(|sp| sp.kind == SpanKind::Body && sp.id != first).unwrap().id;
        let warm = warmup(&s, first);
        let mut real = request(&s, second);
        real.versions.context_revision = warm.versions.context_revision;
        real.versions.layout_version = warm.versions.layout_version;
        queue_latest(&s, warm);
        queue_latest(&s, real);
        assert_eq!(take_ready_request(&s, 0, Instant::now()).0.unwrap().par_id, second);
    }

    #[test]
    fn a_derived_latest_edit_waits_for_its_queued_anchor() {
        let (s, _, first) = fixture();
        let second = s.files.lock()["main.tex"].spans.iter()
            .find(|sp| sp.kind == SpanKind::Body && sp.id != first).unwrap().id;
        let anchor = request(&s, first);
        let mut child = request(&s, second);
        child.edit_id = anchor.edit_id + 1;
        s.live.lock().unit(second).derived = Some((first, first, true));
        queue_latest(&s, anchor);
        queue_latest(&s, child);
        assert_eq!(take_ready_request(&s, 0, Instant::now()).0.unwrap().par_id, first);
        assert_eq!(take_ready_request(&s, 0, Instant::now()).0.unwrap().par_id, second);
    }

    #[test]
    fn a_queued_request_cannot_reuse_superseded_context() {
        let (s, rx, id) = fixture();
        let req = request(&s, id);
        s.layout.lock().context_revision = req.versions.context_revision + 1;
        queue_latest(&s, req);
        assert!(take_ready_request(&s, 0, Instant::now()).0.is_none());
        assert!(rx.try_iter().any(|e| matches!(e, Event::BackgroundScheduled { .. })),
            "the current source must be rerouted when no replacement context exists");
    }

    #[test]
    fn obsolete_slow_results_still_count_without_being_published() {
        let (s, rx, id) = fixture();
        s.full_cost.lock().record(Duration::from_millis(1300));
        s.live.lock().unit(id).measured_once = true;
        for i in 0..3 {
            let mut req = request(&s, id);
            req.sample_epoch = Some(0);
            replace(&s, id, &format!("New correction {i}.\n"));
            let mut result: crate::engine::CompileResult =
                serde_json::from_value(serde_json::json!({"req":1,"status":"ok"})).unwrap();
            result.dl = Some(DisplayList::default());
            handle_result(&s, req, result, Default::default(),
                Instant::now() - Duration::from_millis(1800), 0);
        }
        assert!(!s.live.lock().get(id).unwrap().cost.allows(Instant::now()));
        assert!(rx.try_iter().all(|e| !matches!(e, Event::ParagraphUpdate { .. })));
    }

    #[test]
    fn a_background_pass_that_finished_during_service_invalidates_the_cost_sample() {
        let (s, _, id) = fixture();
        s.full_cost.lock().record(Duration::from_millis(1300));
        s.live.lock().unit(id).measured_once = true;
        let mut req = request(&s, id);
        req.sample_epoch = Some(0);
        s.bg_epoch.store(1, Ordering::SeqCst);
        for _ in 0..3 {
            record_live_cost(&s, &req, Duration::from_millis(1500), true, 0);
        }
        let live = s.live.lock();
        assert!(live.get(id).unwrap().cost.allows(Instant::now()));
        assert_eq!(live.get(id).unwrap().cost.estimate(), None);
    }

    #[test]
    fn a_moderate_live_unit_is_not_demoted_just_for_exceeding_fifty_ms() {
        let (s, _, id) = fixture();
        s.full_cost.lock().record(Duration::from_millis(1300));
        s.live.lock().unit(id).measured_once = true;
        let mut req = request(&s, id);
        req.sample_epoch = Some(0);
        for _ in 0..9 {
            record_live_cost(&s, &req, Duration::from_millis(60), true, 0);
        }
        assert!(s.live.lock().get(id).unwrap().cost.allows(Instant::now()));
    }

    #[test]
    fn full_scheduling_delay_is_part_of_the_latency_comparison() {
        let (s, _, id) = fixture();
        s.full_cost.lock().record(Duration::from_millis(1300));
        s.live.lock().unit(id).measured_once = true;
        let mut req = request(&s, id);
        req.sample_epoch = Some(0);
        for _ in 0..3 {
            record_live_cost(&s, &req, Duration::from_millis(1500), true, 0);
        }
        assert!(s.live.lock().get(id).unwrap().cost.allows(Instant::now()),
            "1500ms live is earlier than 1300ms full plus 300ms quiet time");
    }

    #[test]
    fn a_performance_recovery_trial_does_not_overtake_a_healthy_edit() {
        let (s, _, first) = fixture();
        let second = s.files.lock()["main.tex"].spans.iter()
            .find(|sp| sp.kind == SpanKind::Body && sp.id != first).unwrap().id;
        let older = request(&s, first);
        let mut trial = request(&s, second);
        trial.edit_id = older.edit_id + 1;
        let at = Instant::now() - Duration::from_secs(2);
        for _ in 0..3 {
            s.live.lock().unit(second).cost.record(Duration::from_millis(1800), Duration::from_millis(50),
                Some(Duration::from_millis(1300)), false, at);
        }
        queue_latest(&s, older);
        queue_latest(&s, trial);
        assert_eq!(take_ready_request(&s, 0, Instant::now()).0.unwrap().par_id, first);
    }

    #[test]
    fn semantic_dirty_state_blocks_a_previously_replayable_other_input() {
        let (s, _, origin) = fixture();
        warmup(&s, origin);
        let remote = FileBuf::new("Remote paragraph.\n", &mut s.ids.lock(), 1);
        let remote_id = remote.spans.iter().find(|sp| sp.kind == SpanKind::Body).unwrap().id;
        s.files.lock().insert("remote.tex".into(), remote);
        {
            let mut layout = s.layout.lock();
            let mut unit = layout.units[0].clone();
            unit.uid = remote_id.0 as i64;
            unit.span = Some(remote_id);
            unit.captured.kind = "par".into();
            unit.captured.placements = vec![Default::default()];
            unit.first_para = Some(crate::capture::CapturedParagraph {
                begin: Some(Default::default()), ..Default::default()
            });
            let index = layout.units.len();
            layout.by_span.insert(remote_id, index);
            layout.units.push(unit);
        }
        let route = || {
            let files = s.files.lock();
            let fb = &files["remote.tex"];
            s.route_span("remote.tex", &files, fb, fb.span(remote_id).unwrap(), 2, 2,
                &s.layout.lock(), &s.policy.lock())
        };
        assert!(route().0.is_some());
        s.note_semantic_change(2, origin, false);
        let (request, reasons) = route();
        assert!(request.is_none() && reasons.iter().any(|r| r.contains("semantic context")));
        s.note_semantic_change(3, remote_id, false);
        assert_eq!(*s.semantic_change.lock(), Some(SemanticChange { revision: 3, origin: ParaId(0), counters_changed: false }), "another semantic origin invalidates the exemption");
        s.layout.lock().snapshot_revision = 3;
        assert!(route().0.is_some());
    }

    #[test]
    fn splitting_a_unit_does_not_delete_its_unchanged_label_evidence() {
        let (s, rx, id) = fixture();
        replace(&s, id, "First half.\\label{unchanged}\nSecond half.\n\n");
        let session = Session {
            shared: Arc::new(s), events: rx,
            requeued: Mutex::new(Default::default()), threads: vec![],
        };
        let at = session.document_text("main.tex").unwrap().find("Second half.").unwrap();
        let result = session.apply_edit("main.tex", Edit {
            start_byte: at, end_byte: at, text: "\n".into(),
        }).unwrap();
        assert_eq!(result.outcome.added.len() + result.outcome.touched.len(), 2);
        assert!(session.shared.semantic_change.lock().is_none(),
            "splitting boundaries preserves the aggregate label sequence");
    }

    #[test]
    fn a_completed_known_command_releases_its_earlier_unknown_prefix() {
        for (captured, counters_changed, clears) in [(true, false, true), (true, true, false), (false, false, false)] {
            let (s, rx, id) = fixture();
            if captured {
                let spans = crate::layout::snapshot_spans_of(&s.files.lock()["main.tex"], "main.tex", &s.policy.lock(), false);
                let cap = crate::capture::CaptureResult {
                    out_dir: Default::default(), jobname: "unused".into(),
                    json: Default::default(), pdf: Default::default(), log: Default::default(),
                    wall: Duration::ZERO, exit_ok: true,
                };
                s.layout.lock().install(&cap, spans, 1).unwrap();
            }
            s.note_semantic_change(2, id, counters_changed);
            let session = Session {
                shared: Arc::new(s), events: rx,
                requeued: Mutex::new(Default::default()), threads: vec![],
            };
            let at = session.document_text("main.tex").unwrap().find("Original").unwrap();
            session.apply_edit("main.tex", Edit {
                start_byte: at, end_byte: at, text: "Known ".into(),
            }).unwrap();
            assert_eq!(session.shared.semantic_change.lock().is_none(), clears,
                "only proven captured source can retract speculation; counters and new units need full capture");
        }
    }

    #[test]
    fn deleting_a_label_while_leaving_an_unfinished_survivor_dirties_context() {
        let (s, rx, id) = fixture();
        replace(&s, id, "Removed text.\\label{gone}\n\n");
        let range = {
            let files = s.files.lock();
            let fb = &files["main.tex"];
            fb.span(id).unwrap().range.start..fb.spans.iter()
                .filter(|sp| sp.kind == SpanKind::Body).last().unwrap().range.end
        };
        let session = Session {
            shared: Arc::new(s), events: rx,
            requeued: Mutex::new(Default::default()), threads: vec![],
        };
        let result = session.apply_edit("main.tex", Edit {
            start_byte: range.start, end_byte: range.end, text: "$Unfinished\n\n".into(),
        }).unwrap();
        assert!(!result.outcome.removed.is_empty());
        assert!(session.shared.semantic_change.lock().is_some(),
            "an unfinished survivor must not hide a deleted cross-unit key");
    }

    #[test]
    fn extending_a_span_at_its_end_does_not_retract_a_deleted_captured_label() {
        let (s, rx, id) = fixture();
        replace(&s, id, "Original\\label{key}\n\n");
        let spans = crate::layout::snapshot_spans_of(&s.files.lock()["main.tex"], "main.tex", &s.policy.lock(), false);
        let cap = crate::capture::CaptureResult {
            out_dir: Default::default(), jobname: "unused".into(),
            json: Default::default(), pdf: Default::default(), log: Default::default(),
            wall: Duration::ZERO, exit_ok: true,
        };
        s.layout.lock().install(&cap, spans, 1).unwrap();
        let session = Session {
            shared: Arc::new(s), events: rx,
            requeued: Mutex::new(Default::default()), threads: vec![],
        };
        let at = session.document_text("main.tex").unwrap().find("\\label{key}").unwrap();
        session.apply_edit("main.tex", Edit {
            start_byte: at, end_byte: at + "\\label{key}".len(), text: String::new(),
        }).unwrap();
        assert_eq!(session.shared.semantic_change.lock().as_ref().map(|change| change.origin), Some(id));
        let end = session.shared.files.lock()["main.tex"].span(id).unwrap().range.end;
        let result = session.apply_edit("main.tex", Edit {
            start_byte: end, end_byte: end, text: "More text.\n".into(),
        }).unwrap();
        assert!(result.outcome.touched.contains(&id), "the endpoint insertion must extend the original span");
        assert!(session.shared.semantic_change.lock().is_some(),
            "the captured label is still deleted; a boundary insertion cannot establish semantic equality");
    }

    fn reserve_cost_trial(s: &Shared, id: ParaId) {
        let at = Instant::now() - Duration::from_secs(2);
        let mut live = s.live.lock();
        let cost = &mut live.unit(id).cost;
        for _ in 0..3 {
            cost.record(Duration::from_millis(1800), Duration::from_millis(50),
                Some(Duration::from_millis(1300)), false, at);
        }
        assert!(cost.begin_trial(Instant::now()));
    }

    #[test]
    fn a_failed_server_releases_a_reserved_performance_trial() {
        let (s, _, id) = fixture();
        reserve_cost_trial(&s, id);
        s.live.lock().unit(id).measured_once = true;
        engine_failed(&s, &request(&s, id), anyhow!("synthetic pipe failure"), 0, None);
        let live = s.live.lock();
        assert!(live.get(id).unwrap().cost.allows(Instant::now() + Duration::from_secs(2)));
        assert!(!live.get(id).unwrap().measured_once, "a replacement process starts cold");
    }

    #[test]
    fn discarding_an_old_generation_releases_its_abandoned_trial() {
        let (s, _, id) = fixture();
        reserve_cost_trial(&s, id);
        s.link.lock().inflight = Some(InFlight {req: request(&s, id), t0: Instant::now()});
        s.engine_generation.store(1, Ordering::SeqCst);
        let s = Arc::new(s);
        let mut engine = EngineLoop {s: s.clone(), server: None, server_generation: 0,
            labels_sent: 0, server_bbl: None, standby: None, bbl_checked: u64::MAX};
        engine.collect_inflight(1);
        assert!(s.live.lock().get(id).unwrap().cost.allows(Instant::now() + Duration::from_secs(2)));
    }

    #[test]
    fn a_broken_direct_write_releases_its_trial_and_preserves_the_request() {
        let (s, rx, id) = fixture();
        let req = request(&s, id);
        let at = Instant::now() - Duration::from_secs(2);
        for _ in 0..3 {
            s.live.lock().unit(id).cost.record(Duration::from_millis(1800), Duration::from_millis(50),
                Some(Duration::from_millis(1300)), false, at);
        }
        {
            let mut link = s.link.lock();
            link.writer = Some(std::fs::File::open("/dev/null").unwrap());
            link.contexts_sent.insert(req.seq);
        }
        let session = Session { shared: Arc::new(s), events: rx,
            requeued: Mutex::new(Default::default()), threads: vec![] };
        session.dispatch_fast(req);
        assert!(session.shared.pending.lock().contains_key(&id));
        assert!(session.shared.live.lock().get(id).unwrap().cost.allows(Instant::now() + Duration::from_secs(2)));
    }

    #[test]
    fn an_unchanged_failed_request_is_removed_from_the_queue_without_repeating_it() {
        let (s, _, id) = fixture();
        let failed = request(&s, id);
        engine_failed(&s, &failed, anyhow!("synthetic timeout"), 0, None);
        s.pending.lock().insert(id, request(&s, id));
        let (req, wait) = take_ready_request(&s, 1, Instant::now() + Duration::from_secs(60));
        assert!(req.is_none() && wait.is_none());
        assert!(s.pending.lock().is_empty());
    }

    #[test]
    fn a_cooling_unit_does_not_delay_another_paragraph() {
        let (s, _, id) = fixture();
        let failed = request(&s, id);
        engine_failed(&s, &failed, anyhow!("synthetic crash"), 0, None);
        replace(&s, id, "Corrected math.\n");
        let other = s.files.lock()["main.tex"]
            .spans
            .iter()
            .find(|sp| sp.kind == SpanKind::Body && sp.id != id)
            .unwrap()
            .id;
        s.pending.lock().insert(id, request(&s, id));
        s.pending.lock().insert(other, request(&s, other));
        let (req, wait) = take_ready_request(&s, 1, Instant::now());
        assert_eq!(req.unwrap().par_id, other);
        assert!(wait.is_some());
        assert!(s.pending.lock().contains_key(&id));
    }

    #[test]
    fn successive_restarts_rebase_requests_but_a_preamble_edit_supersedes_them() {
        let (s, _, id) = fixture();
        let mut req = request(&s, id);
        assert!(rebase_generation(&mut req, 1, 1));
        assert!(rebase_generation(&mut req, 3, 1));
        assert_eq!(req.versions.engine_generation, 3);
        assert!(!rebase_generation(&mut req, 4, 2));
        s.preamble_revision.store(2, Ordering::SeqCst);
        s.engine_generation.store(4, Ordering::SeqCst);
        engine_failed(&s, &req, anyhow!("old preamble failed"), 3, None);
        assert!(s.live.lock().get(id).is_none());
        assert_eq!(s.engine_generation.load(Ordering::SeqCst), 4);
        s.pending.lock().insert(id, req);
        assert!(take_ready_request(&s, 4, Instant::now()).0.is_none());
        assert!(s.pending.lock().is_empty());
    }

    #[test]
    fn clean_recovery_clears_the_failure_diagnostic_and_keeps_bad_content_blocked() {
        let (s, rx, id) = fixture();
        let failed = request(&s, id);
        engine_failed(&s, &failed, anyhow!("synthetic crash"), 0, None);
        assert!(rx
            .try_iter()
            .any(|event| matches!(event, Event::Diagnostics { items, .. } if !items.is_empty())));
        replace(&s, id, "Recovered math.\n");
        let recovered = request(&s, id);
        let mut result: crate::engine::CompileResult =
            serde_json::from_value(serde_json::json!({ "req": 1, "status": "ok" })).unwrap();
        result.dl = Some(DisplayList::default());
        handle_result(&s, recovered, result, Default::default(), Instant::now(), 1);
        assert!(rx.try_iter().any(|event| matches!(event, Event::Diagnostics { source, items } if source == format!("fast:{id:?}") && items.is_empty())));
        assert!(matches!(
            s.live
                .lock()
                .recovery_gate(id, failed.span_hash, Instant::now()),
            RecoveryGate::Blocked(_)
        ));
    }
}
