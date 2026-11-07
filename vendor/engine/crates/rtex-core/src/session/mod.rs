//! The public session API: documents, edits, fast-path compiles, background layouts, events.

use crate::background::{run_pass_timed, snapshot_dir, write_snapshot, BibTool, WarmEngine};
use crate::document::{Edit, EditOutcome, FileBuf, IdAllocator, ParaId, Revision, Span, SpanKind};
use crate::eligibility::{
    check_engine_unit, classify_source, classify_source_with, everypar_allowed, Policy, Reason,
    UnitShape,
};
use crate::engine::{FastServer, Response};
use crate::layout::{EngineUnit, Fragment, LayoutStore, SnapshotSpan, RowBox};
use crate::texlive::TexLive;
use anyhow::{anyhow, Context, Result};
use crossbeam_channel::{unbounded, Receiver, Sender};
use parking_lot::Mutex;
use rtex_dl::DisplayList;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

mod diag;
mod cost;
mod engine_loop;
mod live;
mod passes;
mod route;
mod schedule;

pub use diag::parse_log;
use diag::*;
use cost::{LiveCost, Samples};
use engine_loop::*;
use live::*;
use passes::*;
use schedule::{PassTiming, PassWish};

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub project_root: PathBuf,
    pub main_file: String,
    pub build_dir: PathBuf,
    /// Quiet time (no edit) a background pass waits for after it was asked for.
    pub debounce: Duration,
    /// ... but no longer than this: while typing goes on, the pass runs at this interval.
    pub max_wait: Duration,
    /// A span refused only because a structure in it is still being typed (an unclosed `$`,
    /// `\[`, `\begin`, brace, `\left`, a fraction or script argument) asks for no pass
    /// until it has been left unfinished this long
    /// (default 2 s): a pass on half a formula is replaced as soon as it is closed. Completing
    /// it live in time needs no pass at all (`session::schedule`).
    pub unfinished_settle: Duration,
    /// ... or this long after it was first left unfinished, while it keeps being edited.
    pub unfinished_max_wait: Duration,
    pub max_passes: u32,
    pub trusted_macros: Vec<String>,
    pub fast_on_stale_context: bool,
    pub bib_tool: BibTool,
    pub compile_timeout: Duration,
    /// Limit for each background or export LuaLaTeX run (default five minutes).
    pub pass_timeout: Duration,
    /// Soft live-service target. Three clean samples with no latency benefit or blocked
    /// real edits defer the unit; a slower live result may still beat a full layout.
    pub fast_budget: Duration,
    /// Extra block environments (theorem-like) treated as units, besides those found by scanning
    /// the preamble for `\newtheorem`.
    pub unit_envs: Vec<String>,
    /// Keep a standby lualatex with the preamble loaded for background passes (default true):
    /// a pass then only typesets the body, 3–4× faster for short documents.
    pub warm_background: bool,
    /// How a unit qualifies for the fast path (default `Probe`).
    pub eligibility: EligibilityMode,
    /// Background passes reuse unchanged pictures (tikzpicture, circuitikz) from an earlier
    /// pass's PDF instead of drawing them again (default true; `docs/how-it-works.md`).
    pub picture_cache: bool,
    /// Debugging: a directory the session writes diagnostics into (default: `$RTEX_DEBUG_DIR`
    /// when set, else none). Every engine failure (watchdog, state mismatch, crash) leaves a
    /// bundle there with the request's source, context and picture entries, the server's
    /// driver, preamble, TeX log and stage trace; `requests.log` gets one line per live
    /// compile. C ABI `"debug_dir"`, CLI `rtex serve --debug-dir`.
    pub debug_dir: Option<PathBuf>,
}

/// Diagnostic view of one layout unit (`Session::layout_units`, `rtex serve` `units`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct LayoutUnitInfo {
    pub uid: i64,
    pub kind: String,
    pub name: Option<String>,
    pub file: Option<String>,
    pub first_line: i64,
    pub last_line: Option<i64>,
    pub rows: i64,
    pub span: Option<ParaId>,
}

/// Outcome of a probe compile (probe mode).
#[derive(Debug, Clone)]
enum ProbeVerdict {
    /// The snapshot text reproduced the layout's rows: edits of the unit go live.
    Verified,
    /// Rows differed, the compile failed, or there was nothing to compare (why).
    Mismatch(String),
    /// The compile changed the meaning of a control sequence it mentions (names).
    Leak(String),
}

/// How the session decides that a unit may be typeset live.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EligibilityMode {
    /// Only units whose every command is on the allow-list (`eligibility.rs`).
    AllowList,
    /// Any structurally sound unit: one whose vocabulary is not allow-listed is probed first —
    /// its text as the last pass typeset it is compiled once and compared row by row with the
    /// pass; a match verifies it for this layout, anything else keeps it on the background
    /// path (`BackgroundScheduled` with an `unverified:` reason). Allow-listed units skip the
    /// probe. A unit the layout does not know yet (typed fresh, split off) has nothing to
    /// compare with: it is compiled on a borrowed context only when its vocabulary is
    /// allow-listed, or when what is not are picture environments the cache holds (their
    /// bodies are not run); otherwise it waits for the pass.
    #[default]
    Probe,
}

impl EligibilityMode {
    pub fn parse(s: &str) -> Option<EligibilityMode> {
        match s.trim().to_ascii_lowercase().as_str() {
            "probe" => Some(EligibilityMode::Probe),
            "allowlist" | "allow-list" | "allow_list" => Some(EligibilityMode::AllowList),
            _ => None,
        }
    }
}

impl SessionConfig {
    pub fn new(project_root: impl Into<PathBuf>, main_file: impl Into<String>) -> Self {
        let project_root = project_root.into();
        SessionConfig {
            build_dir: project_root.join("build").join("rtex"),
            project_root,
            main_file: main_file.into(),
            debounce: Duration::from_millis(300),
            max_wait: Duration::from_secs(2),
            unfinished_settle: Duration::from_secs(2),
            unfinished_max_wait: Duration::from_secs(8),
            max_passes: 5,
            trusted_macros: Vec::new(),
            fast_on_stale_context: true,
            bib_tool: BibTool::Auto,
            compile_timeout: Duration::from_secs(5),
            pass_timeout: crate::capture::DEFAULT_PASS_TIMEOUT,
            fast_budget: Duration::from_millis(50),
            unit_envs: Vec::new(),
            warm_background: true,
            eligibility: EligibilityMode::Probe,
            picture_cache: true,
            debug_dir: std::env::var_os("RTEX_DEBUG_DIR")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Default, PartialEq, Eq)]
pub struct Versions {
    pub source_revision: Revision,
    pub context_revision: u64,
    pub engine_generation: u64,
    pub layout_version: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state")]
pub enum Convergence {
    Converged,
    Converging { pass: u32, reasons: Vec<String> },
    PassLimitReached { passes: u32, reasons: Vec<String> },
    Stale { pending_since: Revision },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state")]
pub enum CompileStatus {
    Ok,
    CompiledWithErrors { count: usize },
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub severity: String,
    pub file: Option<String>,
    pub line: Option<i64>,
    pub message: String,
    pub context: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Timing {
    pub total_us: u64,
    pub tex_us: u64,
    pub traverse_us: u64,
    pub pack_us: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageUpdate {
    pub page: i64,
    pub exact: bool,
    pub hash: u64,
    pub dl: DisplayList,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParagraphPlacement {
    pub par_id: ParaId,
    pub fragments: Vec<Fragment>,
    /// Number of rows (typeset lines, display rows, float rows) of the unit.
    pub lines: i64,
    /// Unit kind: "par", "env:<name>" or "heading:<name>".
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event")]
// ParagraphUpdate carries its display list inline: an event is moved once, through a channel,
// and boxing the field would change the public type hosts match on for no measurable gain
#[allow(clippy::large_enum_variant)]
pub enum Event {
    ParagraphUpdate {
        par_id: ParaId,
        edit_id: u64,
        versions: Versions,
        status: String,
        reasons: Vec<String>,
        fragments: Vec<Fragment>,
        pagination_stale: bool,
        context_stale: bool,
        /// A background pass is running or still asked for (it will deliver a layout). False
        /// tells a host that nothing more follows this result: a span that waited for its
        /// structure to be completed was completed live.
        pass_pending: bool,
        dl: DisplayList,
        diagnostics: Vec<Diagnostic>,
        timing: Timing,
    },
    LayoutUpdate {
        versions: Versions,
        /// Source snapshot of this complete layout, including unchanged retained pages.
        /// Hosts can advance equal anchors to this revision after a successful layout.
        #[serde(skip_serializing_if = "Option::is_none")]
        source_revision: Option<Revision>,
        compile: CompileStatus,
        convergence: Convergence,
        passes: u32,
        pages_changed: Vec<PageUpdate>,
        pages_total: i64,
        placements: Vec<ParagraphPlacement>,
        eligible_paragraphs: Vec<ParaId>,
        pdf_fallback: Option<PathBuf>,
        wall_ms: u64,
    },
    Diagnostics {
        source: String,
        items: Vec<Diagnostic>,
    },
    EngineState {
        engine_generation: u64,
        state: String,
        reason: Option<String>,
    },
    BackgroundScheduled {
        par_id: Option<ParaId>,
        reasons: Vec<String>,
        edit_id: u64,
    },
    PdfExported {
        job_id: u64,
        path: Option<PathBuf>,
        status: CompileStatus,
        converged: bool,
        passes: u32,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct EditResult {
    pub edit_id: u64,
    pub source_revision: Revision,
    pub outcome: EditOutcome,
    pub routed: String,
    pub reasons: Vec<String>,
    /// Host-side stage times in µs: segmentation, eligibility, request dispatch.
    pub host_us: [u64; 3],
}

/// The kernel's `\everypar` after a heading (`\@afterheading`), replayed for a paragraph typed
/// fresh right after a heading span.
const AFTER_HEADING_EVERYPAR: &str = "\\if@nobreak \\@nobreakfalse \\clubpenalty \\@M \\if@afterindent \\else {\\setbox \\z@ \\lastbox }\\fi \\else \\clubpenalty \\@clubpenalty \\everypar {}\\fi ";

struct FastRequest {
    queued_at: Instant,
    sample_epoch: Option<u64>,
    /// Internal warm-up compile: result is discarded, no event is emitted.
    warmup: bool,
    par_id: ParaId,
    edit_id: u64,
    span_hash: u64,
    source: String,
    /// Source origin captured with this exact request, never looked up after edits arrive.
    source_file: String,
    source_first_line: i64,
    /// Picture cache entries for the source's picture environments, in order (JSON array;
    /// empty when none is cached), and how many pictures the source has.
    pics: String,
    pics_n: usize,
    seq: i64,
    /// Context object for the server; None when the engine link already holds this context
    /// (the engine thread builds it from the layout store when it must send it).
    ctx: Option<serde_json::Value>,
    versions: Versions,
    context_stale: bool,
    expected_rows: i64,
    /// Probe mode: the unit must be proven first (its snapshot text, fetched from the layout
    /// current when the engine thread gets to it, compiled and compared with that layout).
    probe: bool,
    /// The unit was let through unproven because every picture in it comes from the cache
    /// (its only vocabulary beyond the allow-list): a result that drew a picture after all is
    /// unverified and the unit waits for the pass.
    pics_required: bool,
}

/// A compile the server is working on (sent either by the engine thread or directly by the
/// host thread through `EngineLink::writer`).
struct InFlight {
    req: FastRequest,
    t0: Instant,
}

/// Host-visible side of the fast server: lets `apply_edit` submit a compile frame straight to
/// the server's stdin when the server is idle, saving the wake-up of the engine thread. The
/// engine thread owns the server and reads every result, in order.
#[derive(Default)]
struct EngineLink {
    writer: Option<std::fs::File>,
    generation: u64,
    inflight: Option<InFlight>,
    contexts_sent: HashSet<i64>,
    context_rev_sent: u64,
    labels_sent: u64,
    next_req: i64,
    /// A probe compile is running on the engine thread without the lock held: the direct
    /// dispatch path must not write to the server meanwhile.
    probing: bool,
    /// Probe mode statistics: probe compiles run and their total time.
    probes: u64,
    probe_us: u64,
}

struct Shared {
    link: Mutex<EngineLink>,
    files: Mutex<BTreeMap<String, FileBuf>>,
    ids: Mutex<IdAllocator>,
    source_revision: AtomicU64,
    preamble_revision: AtomicU64,
    /// Per file: last revision at which a background-only span or the preamble changed.
    bg_change: Mutex<HashMap<String, Vec<(Revision, i64)>>>, // (revision, first line of the changed span)
    /// Latest known outgoing semantic change and its first still-valid input context.
    semantic_change: Mutex<Option<SemanticChange>>,
    layout: Mutex<LayoutStore>,
    engine_generation: AtomicU64,
    events: Sender<Event>,
    /// Latest request per unit; real edits precede warm-ups, preserving derived anchors.
    pending: Mutex<BTreeMap<ParaId, FastRequest>>,
    pending_signal: (Sender<()>, Receiver<()>),
    bg_signal: (Sender<BgCmd>, Receiver<BgCmd>),
    /// What the next background pass is for (`schedule`); `bg_signal` only wakes the thread.
    pass_wish: Mutex<PassWish>,
    shutdown: AtomicBool,
    /// A background pass is compiling right now: fast-path timings are not budget evidence.
    bg_running: AtomicBool,
    bg_epoch: AtomicU64,
    full_cost: Mutex<Samples>,
    /// Background passes are deferred while paused (benchmarks, host-controlled quiet periods).
    bg_paused: AtomicBool,
    bg_pending_while_paused: AtomicBool,
    cfg: SessionConfig,
    tl: TexLive,
    policy: Mutex<Policy>,
    /// Files the preamble `\input`s: an edit to one of them is a preamble change.
    preamble_inputs: Mutex<std::collections::BTreeSet<String>>,
    /// Files read with `\input` anywhere (see `document::fast_source`).
    inputted: Mutex<std::collections::BTreeSet<String>>,
    edit_counter: AtomicU64,
    convergence: Mutex<Option<Convergence>>,
    /// What the live path records per span between layouts (borrowed contexts, live rows
    /// and placements, probe verdicts, cost samples, leaks...), with their expiry rules.
    live: Mutex<LiveUnits>,
    /// Standby background engine (preamble loaded, waiting for the body).
    standby: Mutex<Option<WarmEngine>>,
    /// Directory of the last finished background pass (its aux family seeds the next pass;
    /// its PDF and capture files stay until a later pass reuses the directory).
    last_pass_dir: Mutex<Option<PathBuf>>,
    /// The picture cache index as of a layout version (the live engine reuses cached pictures).
    pic_index: Mutex<Option<(u64, crate::piccache::PicCache)>>,
    /// The source scan for pictures at a revision (the whole project; one scan per edit, not
    /// one per routed span).
    pic_scan: Mutex<Option<(Revision, Arc<Vec<crate::piccache::PictureRef>>)>>,
}

enum BgCmd {
    /// Wakes the scheduler; `Shared::pass_wish` says what for.
    Pass,
    Export(u64, PathBuf),
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SemanticChange {
    revision: Revision,
    origin: ParaId,
    counters_changed: bool,
}

impl Shared {
    fn note_semantic_change(&self, rev: Revision, origin: ParaId, counters_changed: bool) {
        let snapshot = self.layout.lock().snapshot_revision;
        let mut dirty = self.semantic_change.lock();
        match dirty.as_mut().filter(|change| change.revision > snapshot) {
            Some(change) => {
                change.revision = change.revision.max(rev);
                if change.origin != origin { change.origin = ParaId(0); }
                change.counters_changed |= counters_changed;
            }
            None => *dirty = Some(SemanticChange { revision: rev, origin, counters_changed }),
        }
    }

    fn clean_sample_epoch(&self) -> Option<u64> {
        let epoch = self.bg_epoch.load(Ordering::SeqCst);
        (!self.bg_running.load(Ordering::SeqCst)).then_some(epoch)
    }

    fn full_latency(&self, now: Instant) -> Option<Duration> {
        if self.bg_running.load(Ordering::SeqCst) { return None; }
        let service = {
            let samples = self.full_cost.lock();
            samples.median().or_else(|| samples.latest())?
        };
        let wait = match self.pass_wish.lock().wait(&self.pass_timing(), now) {
            schedule::Wait::Run => Duration::ZERO,
            schedule::Wait::Nothing => self.cfg.debounce,
            schedule::Wait::For(wait) => wait,
        };
        Some(service.saturating_add(wait))
    }
    /// A background pass is needed: it runs once the writer pauses (`schedule`).
    fn need_pass(&self) {
        self.pass_wish.lock().need(Instant::now());
        self.bg_signal.0.send(BgCmd::Pass).ok();
    }

    /// A background pass without waiting (the host asked, or no layout exists yet).
    fn pass_now(&self) {
        self.pass_wish.lock().now();
        self.bg_signal.0.send(BgCmd::Pass).ok();
    }

    /// A pass runs now or will (see `Event::ParagraphUpdate::pass_pending`).
    fn pass_pending(&self) -> bool {
        self.pass_wish.lock().pending()
    }

    fn pass_timing(&self) -> PassTiming {
        PassTiming {
            debounce: self.cfg.debounce,
            max_wait: self.cfg.max_wait,
            settle: self.cfg.unfinished_settle,
            settle_max: self.cfg.unfinished_max_wait,
        }
    }
}

/// Reasons that only say a structure or math argument is still being typed.
/// A span refused for these alone keeps what
/// is drawn for it and does not ask for a pass at once (`schedule`).
fn unfinished_only(reasons: &[String]) -> bool {
    let structural = |r: &String| {
        matches!(
            r.as_str(),
            "UnbalancedMath" | "UnbalancedEnvironment" | "UnbalancedBraces" | "IncompleteMath" | "IncompleteCommand"
        )
    };
    reasons.iter().any(structural) && reasons.iter().all(|r| structural(r) || r == "NoContext")
}

/// Whether `edit` (already applied to `fb`, `removed` being the text it replaced) lay between
/// two units and left a blank line between them both before and after it.
fn blank_lines_only_changed(fb: &FileBuf, edit: &Edit, removed: &str) -> bool {
    let inserted_end = edit.start_byte + edit.text.len();
    let (Some(gap_start), Some(gap_end)) = (
        fb.spans
            .iter()
            .filter(|sp| sp.range.end <= edit.start_byte)
            .map(|sp| sp.range.end)
            .max(),
        fb.spans
            .iter()
            .filter(|sp| sp.range.start >= inserted_end)
            .map(|sp| sp.range.start)
            .min(),
    ) else {
        return false;
    };
    let Some(new_gap) = fb.text.get(gap_start..gap_end) else {
        return false;
    };
    let at = edit.start_byte - gap_start;
    let old_gap = format!("{}{}{}", &new_gap[..at], removed, &new_gap[at + edit.text.len()..]);
    new_gap.contains('\n') && old_gap.contains('\n')
}

/// The scan finds an unfinished structure or math argument in `text`.
fn structurally_unfinished(text: &str, policy: &Policy) -> bool {
    crate::eligibility::classify_source(text, policy).1.iter().any(Reason::is_unfinished)
}

pub struct Session {
    shared: Arc<Shared>,
    events: Receiver<Event>,
    /// Events taken out by a poll but handed back (C ABI returns one event per call).
    requeued: Mutex<std::collections::VecDeque<Event>>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Session {
    pub fn open(cfg: SessionConfig) -> Result<Session> {
        let tl = TexLive::discover()?;
        let project_root = crate::paths::canonical(&cfg.project_root).context("project root")?;
        let cfg = SessionConfig {
            project_root,
            main_file: crate::paths::key(&cfg.main_file),
            ..cfg
        };
        std::fs::create_dir_all(&cfg.build_dir)?;
        let cfg = SessionConfig {
            build_dir: crate::paths::canonical(&cfg.build_dir)?,
            ..cfg
        };
        // layout PDFs are numbered per session: an earlier session's copies would stay for
        // as long as this one takes to reach their numbers
        if let Ok(rd) = std::fs::read_dir(cfg.build_dir.join("bg")) {
            for ent in rd.flatten() {
                let name = ent.file_name().to_string_lossy().into_owned();
                if name.starts_with("layout-") && name.ends_with(".pdf") {
                    let _ = std::fs::remove_file(ent.path());
                }
            }
        }
        // the main file and, transitively, every file it \input/\includes
        let texts = crate::document::load_project_files(&cfg.project_root, &cfg.main_file)
            .with_context(|| format!("reading {}", cfg.main_file))?;
        let mut ids = IdAllocator(0);
        let mut files = BTreeMap::new();
        let preamble = effective_preamble(&texts, &cfg.main_file);
        let preamble_inputs = preamble_input_set(&texts, &cfg.main_file);
        let mut policy = Policy::from_preamble(&preamble, &cfg.trusted_macros, &cfg.unit_envs);
        policy.permissive = cfg.eligibility == EligibilityMode::Probe;
        let envs: Vec<String> = policy.theorem_envs.iter().cloned().collect();
        // the main file first so its span ids come first
        files.insert(
            cfg.main_file.clone(),
            FileBuf::with_block_envs(&texts[&cfg.main_file], &mut ids, 1, envs.clone()),
        );
        for (name, text) in texts.iter().filter(|(n, _)| **n != cfg.main_file) {
            files.insert(
                name.clone(),
                FileBuf::with_block_envs(text, &mut ids, 1, envs.clone()),
            );
        }
        let (tx, rx) = unbounded();
        let shared = Arc::new(Shared {
            link: Mutex::new(EngineLink {
                next_req: 1,
                ..Default::default()
            }),
            files: Mutex::new(files),
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
            tl,
            policy: Mutex::new(policy),
            preamble_inputs: Mutex::new(preamble_inputs),
            inputted: Mutex::new(crate::document::inputted_files(&texts)),
            edit_counter: AtomicU64::new(0),
            live: Mutex::new(LiveUnits::default()),
            convergence: Mutex::new(None),
            standby: Mutex::new(None),
            last_pass_dir: Mutex::new(None),
            pic_index: Mutex::new(None),
            pic_scan: Mutex::new(None),
        });
        let mut threads = Vec::new();
        {
            let s = shared.clone();
            threads.push(
                std::thread::Builder::new()
                    .name("rtex-engine".into())
                    .spawn(move || engine_thread(s))?,
            );
        }
        {
            let s = shared.clone();
            threads.push(
                std::thread::Builder::new()
                    .name("rtex-background".into())
                    .spawn(move || background_thread(s))?,
            );
        }
        shared.pass_now();
        shared.pending_signal.0.send(()).ok(); // eager server start
        Ok(Session {
            shared,
            events: rx,
            requeued: Mutex::new(std::collections::VecDeque::new()),
            threads,
        })
    }

    pub fn versions(&self) -> Versions {
        let layout = self.shared.layout.lock();
        Versions {
            source_revision: self.shared.source_revision.load(Ordering::SeqCst),
            context_revision: layout.context_revision,
            engine_generation: self.shared.engine_generation.load(Ordering::SeqCst),
            layout_version: layout.layout_version,
        }
    }

    /// Diagnostic view of the installed layout's units: (unit id, kind, first line, last line,
    /// mapped span).
    pub fn layout_units(&self) -> Vec<LayoutUnitInfo> {
        let layout = self.shared.layout.lock();
        layout
            .units
            .iter()
            .map(|u| LayoutUnitInfo {
                uid: u.uid,
                kind: u.captured.kind.clone(),
                name: u.captured.name.clone(),
                file: u.captured.file.clone(),
                first_line: u.captured.begin_line,
                last_line: u.captured.end_line,
                rows: u.rows(),
                span: u.span,
            })
            .collect()
    }

    pub fn convergence(&self) -> Option<Convergence> {
        self.shared.convergence.lock().clone()
    }

    /// The key a host's path maps to: project-relative, without a leading `./`; an absolute
    /// path inside the project root is made relative.
    fn rel_key(&self, path: &str) -> String {
        let p = Path::new(path);
        if p.is_absolute() {
            if let Ok(rel) = p.strip_prefix(&self.shared.cfg.project_root) {
                return crate::paths::key(&rel.to_string_lossy());
            }
            if let Ok(canon) = crate::paths::canonical(p) {
                if let Ok(rel) = canon.strip_prefix(&self.shared.cfg.project_root) {
                    return crate::paths::key(&rel.to_string_lossy());
                }
            }
            return path.to_string();
        }
        let path = &crate::paths::key(path);
        let mut t = path.as_str();
        while let Some(r) = t.strip_prefix("./") {
            t = r;
        }
        t.to_string()
    }

    pub fn document_text(&self, rel_path: &str) -> Option<String> {
        let key = self.rel_key(rel_path);
        self.shared.files.lock().get(&key).map(|f| f.text.clone())
    }

    /// Probe compiles run so far (probe mode): a unit whose only vocabulary beyond the
    /// allow-list is cached pictures needs none.
    pub fn probes(&self) -> u64 {
        self.shared.link.lock().probes
    }

    pub fn spans(&self, rel_path: &str) -> Vec<crate::document::Span> {
        let key = self.rel_key(rel_path);
        self.shared
            .files
            .lock()
            .get(&key)
            .map(|f| f.spans.clone())
            .unwrap_or_default()
    }

    /// Replace a whole buffer. Treated as an edit covering the full text.
    pub fn set_document(&self, rel_path: &str, text: &str) -> Result<EditResult> {
        let key = self.rel_key(rel_path);
        let rel_path = key.as_str();
        let mut files = self.shared.files.lock();
        let len = files.get(rel_path).map(|f| f.text.len());
        if len.is_none() {
            let previous_preamble = effective_preamble(&texts_of(&files), &self.shared.cfg.main_file);
            let rev = self.shared.source_revision.fetch_add(1, Ordering::SeqCst) + 1;
            let fb = FileBuf::with_block_envs(
                text,
                &mut self.shared.ids.lock(),
                rev,
                self.shared
                    .policy
                    .lock()
                    .theorem_envs
                    .iter()
                    .cloned()
                    .collect(),
            );
            files.insert(rel_path.to_string(), fb);
            drop(files);
            self.load_new_inputs();
            let preamble_changed = {
                let files = self.shared.files.lock();
                let texts = texts_of(&files);
                *self.shared.inputted.lock() = crate::document::inputted_files(&texts);
                previous_preamble != effective_preamble(&texts, &self.shared.cfg.main_file)
            };
            if preamble_changed {
                self.invalidate_contexts(rel_path, rev, Instant::now());
            } else {
                self.schedule_background();
            }
            let edit_id = self.shared.edit_counter.fetch_add(1, Ordering::SeqCst) + 1;
            return Ok(EditResult {
                edit_id,
                source_revision: rev,
                outcome: EditOutcome { preamble_changed, ..Default::default() },
                routed: if preamble_changed { "preamble" } else { "background" }.into(),
                reasons: vec!["new file".into()],
                host_us: [0, 0, 0],
            });
        }
        drop(files);
        self.apply_edit(
            rel_path,
            Edit {
                start_byte: 0,
                end_byte: len.unwrap(),
                text: text.to_string(),
            },
        )
    }

    fn invalidate_contexts(&self, rel_path: &str, rev: Revision, at: Instant) {
        self.shared.preamble_revision.store(rev, Ordering::SeqCst);
        self.load_new_inputs();
        {
            let files = self.shared.files.lock();
            let texts = texts_of(&files);
            let preamble = effective_preamble(&texts, &self.shared.cfg.main_file);
            *self.shared.preamble_inputs.lock() =
                preamble_input_set(&texts, &self.shared.cfg.main_file);
            *self.shared.inputted.lock() = crate::document::inputted_files(&texts);
            let mut policy = Policy::from_preamble(
                &preamble,
                &self.shared.cfg.trusted_macros,
                &self.shared.cfg.unit_envs,
            );
            policy.permissive = self.shared.cfg.eligibility == EligibilityMode::Probe;
            let envs: Vec<String> = policy.theorem_envs.iter().cloned().collect();
            *self.shared.policy.lock() = policy;
            drop(files);
            let mut files = self.shared.files.lock();
            for fb in files.values_mut() {
                if fb.extra_block_envs != envs || !fb.run_in_headings.is_empty() {
                    fb.extra_block_envs = envs.clone();
                    fb.run_in_headings.clear();
                    fb.resegment(&mut self.shared.ids.lock(), rev);
                }
            }
        }
        self.shared
            .bg_change
            .lock()
            .entry(rel_path.to_string())
            .or_default()
            .push((rev, 0));
        // restart the engine with the new preamble, drop overlays and the standby, schedule a pass
        if let Some(w) = self.shared.standby.lock().take() {
            w.kill();
        }
        self.shared.live.lock().on_preamble_change();
        *self.shared.semantic_change.lock() = None;
        self.shared.pass_wish.lock().edited(at, true);
        self.shared.engine_generation.fetch_add(1, Ordering::SeqCst);
        self.shared.pending.lock().clear();
        self.shared.pending_signal.0.send(()).ok();
        self.schedule_background();
    }

    /// A host-confirmed deletion of a closed input. Open editor buffers stay authoritative.
    pub fn remove_document(&self, rel_path: &str) -> EditResult {
        let key = self.rel_key(rel_path);
        let edit_id = self.shared.edit_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let mut files = self.shared.files.lock();
        let removed = files.remove(&key);
        let rev = if removed.is_some() {
            self.shared.source_revision.fetch_add(1, Ordering::SeqCst) + 1
        } else {
            self.shared.source_revision.load(Ordering::SeqCst)
        };
        drop(files);
        let changed = removed.is_some();
        let outcome = EditOutcome {
            removed: removed.into_iter().flat_map(|fb| fb.spans.into_iter().map(|sp| sp.id)).collect(),
            ..Default::default()
        };
        // A removed input may have supplied definitions or counters to any following unit.
        if changed {
            self.invalidate_contexts(&key, rev, Instant::now());
        }
        EditResult { edit_id, source_revision: rev, outcome,
            routed: if changed { "preamble" } else { "fast" }.into(),
            reasons: if changed { vec!["source file removed".into()] } else { vec![] },
            host_us: [0, 0, 0] }
    }

    pub fn apply_edit(&self, rel_path: &str, edit: Edit) -> Result<EditResult> {
        let key = self.rel_key(rel_path);
        let rel_path = key.as_str();
        let t_start = Instant::now();
        let edit_id = self.shared.edit_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let is_setup = |text: &str| {
            crate::eligibility::setup_statements(&crate::eligibility::strip_comments(text))
                .is_some()
        };
        let (rev, mut outcome, setup_span, sound_before, removed_text, before_units) = {
            let mut files = self.shared.files.lock();
            let fb = files
                .get_mut(rel_path)
                .ok_or_else(|| anyhow!("unknown file {rel_path}"))?;
            anyhow::ensure!(
                edit.start_byte <= edit.end_byte && edit.end_byte <= fb.text.len(),
                "edit range {}..{} is outside the {}-byte document or reversed",
                edit.start_byte, edit.end_byte, fb.text.len()
            );
            anyhow::ensure!(
                fb.text.is_char_boundary(edit.start_byte) && fb.text.is_char_boundary(edit.end_byte),
                "edit range {}..{} splits a UTF-8 character",
                edit.start_byte, edit.end_byte
            );
            let rev = self.shared.source_revision.fetch_add(1, Ordering::SeqCst) + 1;
            let before_units: Vec<_> = fb.spans.iter()
                .filter(|sp| if edit.start_byte == edit.end_byte {
                    sp.range.contains(&edit.start_byte)
                } else {
                    sp.range.start < edit.end_byte && edit.start_byte < sp.range.end
                })
                .map(|sp| (sp.id, fb.text[sp.range.clone()].to_string())).collect();
            // a setup span (definitions, lengths after \begin{document}) the edit changed or
            // removed, or one it created: the server's preamble changes. A setup span the edit
            // only borders (Enter on the blank line after it) is unchanged.
            let setup_before: Vec<(ParaId, String)> = fb
                .spans
                .iter()
                .filter(|sp| {
                    sp.range.start <= edit.end_byte
                        && edit.start_byte <= sp.range.end
                        && is_setup(&fb.text[sp.range.clone()])
                })
                .map(|sp| (sp.id, fb.text[sp.range.clone()].to_string()))
                .collect();
            // spans the edit touches whose structure was sound before it: an unclosed structure
            // in one is being typed now, not one the scan refuses whatever is typed
            let sound_before: HashSet<ParaId> = {
                let policy = self.shared.policy.lock();
                fb.spans
                    .iter()
                    .filter(|sp| {
                        sp.range.start <= edit.end_byte
                            && edit.start_byte <= sp.range.end
                            && !structurally_unfinished(&fb.text[sp.range.clone()], &policy)
                    })
                    .map(|sp| sp.id)
                    .collect()
            };
            let removed_text = fb
                .text
                .get(edit.start_byte..edit.end_byte)
                .unwrap_or_default()
                .to_string();
            let outcome = fb.apply(&edit, &mut self.shared.ids.lock(), rev);
            let was_setup = setup_before.iter().any(|(id, old)| {
                outcome.removed.contains(id)
                    || (outcome.touched.contains(id) && fb.span_text(*id) != Some(old.as_str()))
            });
            let now_setup = outcome
                .touched
                .iter()
                .chain(outcome.added.iter())
                .any(|id| fb.span_text(*id).map(is_setup).unwrap_or(false));
            (rev, outcome, was_setup || now_setup, sound_before, removed_text, before_units)
        };
        if setup_span || self.shared.preamble_inputs.lock().contains(rel_path) {
            outcome.preamble_changed = true;
        }
        if outcome.preamble_changed {
            self.invalidate_contexts(rel_path, rev, t_start);
            return Ok(EditResult {
                edit_id,
                source_revision: rev,
                outcome,
                routed: "preamble".into(),
                reasons: vec!["preamble changed".into()],
                host_us: [t_start.elapsed().as_micros() as u64, 0, 0],
            });
        }
        let t_seg = t_start.elapsed();
        let (semantic_changed, semantic_complete) = {
            let files = self.shared.files.lock();
            let layout = self.shared.layout.lock();
            let policy = self.shared.policy.lock();
            let fb = &files[rel_path];
            let selected: HashSet<_> = before_units.iter().map(|(id, _)| *id)
                .chain(outcome.touched.iter().chain(&outcome.added).copied()).collect();
            let before = before_units.iter().map(|(id, text)|
                layout.snapshot_text(*id).unwrap_or(text)).collect::<Vec<_>>().join("\n");
            let after: Vec<_> = fb.spans.iter().filter(|sp| selected.contains(&sp.id))
                .map(|sp| &fb.text[sp.range.clone()]).collect();
            let complete = !after.iter().any(|text| structurally_unfinished(text, &policy));
            // A split or merge preserves the aggregate keys, even though each half differs.
            let after = after.join("\n");
            (crate::eligibility::semantic_keys_changed_with(&before, &after, &policy)
                || crate::eligibility::new_unverified_vocabulary(&before, &after, &policy), complete)
        };
        if semantic_changed {
            let origin = outcome.touched.first().or(outcome.added.first()).copied().unwrap_or(ParaId(0));
            self.shared.note_semantic_change(rev, origin, false);
        } else if semantic_complete {
            let files = self.shared.files.lock();
            let layout = self.shared.layout.lock();
            let policy = self.shared.policy.lock();
            let mut dirty = self.shared.semantic_change.lock();
            if dirty.as_ref().is_some_and(|change| !change.counters_changed
                && outcome.touched.iter().chain(&outcome.added).any(|id| *id == change.origin)
                && layout.snapshot_text(change.origin).zip(files.values()
                    .find_map(|fb| fb.span_text(change.origin))).is_some_and(|(before, after)|
                        !structurally_unfinished(after, &policy)
                            && !crate::eligibility::semantic_keys_changed_with(before, after, &policy)
                            && !crate::eligibility::new_unverified_vocabulary(before, after, &policy))) {
                // Completed known syntax can retract a speculative control-word prefix.
                *dirty = None;
            }
        }
        // a new \input/\include line: load the file so its paragraphs get spans (and contexts
        // from the next pass)
        if outcome
            .touched
            .iter()
            .chain(outcome.added.iter())
            .any(|id| {
                let files = self.shared.files.lock();
                files
                    .get(rel_path)
                    .and_then(|fb| fb.span_text(*id))
                    .map(|t| !crate::document::input_targets(t).is_empty())
                    .unwrap_or(false)
            })
        {
            self.load_new_inputs();
        }
        // Every body span the edit touched or created is routed (a split compiles both halves,
        // a merge the merged paragraph, a fresh paragraph borrows a context); the first one in
        // document order decides the reported outcome. Removed spans are announced as empty
        // updates so hosts clear what they drew for them.
        let mut requests: Vec<FastRequest> = Vec::new();
        let mut primary: Option<(ParaId, bool, Vec<String>)> = None;
        // refused for a reason a pass resolves, or only because a structure is unfinished
        let mut any_background = false;
        let mut unfinished: Vec<ParaId> = Vec::new();
        let mut settled: Vec<ParaId> = Vec::new();
        // only the number of blank lines between two units changed (never none to some or some
        // to none: the newlines at the end of an \input file are typeset, and a unit after a
        // block environment starts its own paragraph only after a blank line)
        let blank_lines_only;
        {
            let files = self.shared.files.lock();
            let fb = files
                .get(rel_path)
                .ok_or_else(|| anyhow!("unknown file {rel_path}"))?;
            let layout = self.shared.layout.lock();
            let policy = self.shared.policy.lock();
            let mut cands: Vec<ParaId> = outcome
                .touched
                .iter()
                .chain(outcome.added.iter())
                .copied()
                .collect();
            cands.sort_by_key(|id| fb.span(*id).map(|sp| sp.range.start).unwrap_or(usize::MAX));
            cands.dedup();
            for id in cands {
                let Some(span) = fb.span(id) else { continue };
                let (req, reasons) =
                    self.shared.route_span(rel_path, &files, fb, span, rev, edit_id, &layout, &policy);
                let live = req.is_some();
                if live {
                    settled.push(id);
                } else {
                    // an older request for the span would compile text that is gone
                    self.shared.pending.lock().remove(&id);
                    if unfinished_only(&reasons)
                        && (sound_before.contains(&id)
                            || self.shared.pass_wish.lock().in_episode(id))
                    {
                        unfinished.push(id);
                    } else {
                        any_background = true;
                        settled.push(id);
                    }
                }
                if !live && self.shared.cfg.debug_dir.is_some() {
                    debug_request_line(
                        &self.shared,
                        &format!("par {} refused: {}", id.0, reasons.join("; ")),
                    );
                }
                if primary.is_none() {
                    primary = Some((id, live, reasons));
                }
                if let Some(r) = req {
                    requests.push(r);
                }
            }
            blank_lines_only = blank_lines_only_changed(fb, &edit, &removed_text);
            if !outcome.removed.is_empty() {
                let mut pending = self.shared.pending.lock();
                for id in &outcome.removed {
                    pending.remove(id);
                }
                drop(pending);
                for id in &outcome.removed {
                    self.shared.live.lock().unit(*id).cost = LiveCost::default();
                }
                let versions = Versions {
                    source_revision: rev,
                    context_revision: layout.context_revision,
                    engine_generation: self.shared.engine_generation.load(Ordering::SeqCst),
                    layout_version: layout.layout_version,
                };
                for id in &outcome.removed {
                    self.shared
                        .events
                        .send(Event::ParagraphUpdate {
                            par_id: *id,
                            edit_id,
                            versions,
                            status: "removed".into(),
                            reasons: vec![],
                            fragments: vec![],
                            pagination_stale: true,
                            context_stale: false,
                            pass_pending: true,
                            dl: DisplayList::default(),
                            diagnostics: vec![],
                            timing: Timing::default(),
                        })
                        .ok();
                }
            }
        }
        let t_elig = t_start.elapsed();
        {
            let only_unfinished = !unfinished.is_empty()
                && settled.is_empty()
                && !any_background
                && outcome.added.is_empty()
                && outcome.removed.is_empty();
            let mut wish = self.shared.pass_wish.lock();
            wish.edited(t_start, !only_unfinished);
            let mut due = false;
            for id in settled.iter().chain(outcome.removed.iter()) {
                due |= wish.settled(*id, t_start);
            }
            for id in &unfinished {
                wish.unfinished(*id, t_start, self.shared.cfg.unfinished_settle);
            }
            drop(wish);
            if due {
                self.shared.bg_signal.0.send(BgCmd::Pass).ok();
            }
        }
        if !unfinished.is_empty() {
            // the scheduler times the pass from the wish
            self.shared.bg_signal.0.send(BgCmd::Pass).ok();
        }
        if primary.is_none() && outcome.removed.is_empty() && outcome.added.is_empty() && blank_lines_only {
            // whitespace between units changed (a second blank line typed or deleted): what TeX
            // typesets is the same, and line numbers are rebased by hosts from the edits
            return Ok(EditResult {
                edit_id,
                source_revision: rev,
                outcome,
                routed: "fast".into(),
                reasons: vec![],
                host_us: [t_seg.as_micros() as u64, 0, 0],
            });
        }
        let Some((primary_id, primary_live, primary_reasons)) = primary else {
            // nothing routable (e.g. everything deleted): background only
            self.note_bg_change(rel_path, rev, &outcome);
            self.schedule_background();
            self.shared
                .events
                .send(Event::BackgroundScheduled {
                    par_id: None,
                    reasons: vec!["paragraph boundaries changed".into()],
                    edit_id,
                })
                .ok();
            return Ok(EditResult {
                edit_id,
                source_revision: rev,
                outcome,
                routed: "background".into(),
                reasons: vec!["paragraph boundaries changed".into()],
                host_us: [t_seg.as_micros() as u64, 0, 0],
            });
        };
        for req in requests {
            let mut req = req;
            req.queued_at = t_start;
            self.dispatch_fast(req);
        }
        // a boundary change always needs a pass (pagination of what follows); so does a span
        // the fast path could not take
        if any_background || !outcome.added.is_empty() || !outcome.removed.is_empty()
            || (semantic_changed && unfinished.is_empty()) {
            self.note_bg_change(rel_path, rev, &outcome);
            self.schedule_background();
        }
        let host_us = [
            t_seg.as_micros() as u64,
            (t_elig - t_seg).as_micros() as u64,
            (t_start.elapsed() - t_elig).as_micros() as u64,
        ];
        if primary_live {
            Ok(EditResult {
                edit_id,
                source_revision: rev,
                outcome,
                routed: "fast".into(),
                reasons: primary_reasons,
                host_us,
            })
        } else {
            self.shared
                .events
                .send(Event::BackgroundScheduled {
                    par_id: Some(primary_id),
                    reasons: primary_reasons.clone(),
                    edit_id,
                })
                .ok();
            Ok(EditResult {
                edit_id,
                source_revision: rev,
                outcome,
                routed: "background".into(),
                reasons: primary_reasons,
                host_us: [host_us[0], host_us[1], 0],
            })
        }
    }

    /// Hand a fast request to the server: written straight to its stdin when the server is idle
    /// and already holds the context (no engine-thread wake-up on the critical path), queued for
    /// the engine thread otherwise. Queued requests coalesce per paragraph.
    fn dispatch_fast(&self, mut req: FastRequest) {
        let mut link = self.shared.link.lock();
        let pending_empty = self.shared.pending.lock().is_empty();
        let direct = !req.probe
            && !link.probing
            && link.writer.is_some()
            && link.inflight.is_none()
            && link.generation == req.versions.engine_generation
            && link.context_rev_sent == req.versions.context_revision
            && link.contexts_sent.contains(&req.seq)
            && pending_empty
            && {
                let mut live = self.shared.live.lock();
                live.recovery_ready(req.par_id, req.span_hash, Instant::now())
                    && live.unit(req.par_id).cost.begin_trial(Instant::now())
            };
        if direct {
            let req_id = link.next_req;
            link.next_req += 1;
            let frame = FastServer::encode_compile(req_id, req.seq, &req.source, &req.pics);
            let t0 = Instant::now();
            req.sample_epoch = self.shared.clean_sample_epoch();
            use std::io::Write;
            if link.writer.as_mut().unwrap().write_all(&frame).is_ok() {
                link.inflight = Some(InFlight { req, t0 });
                drop(link);
                // wake the engine thread so it is spinning on the FIFO when the result lands
                self.shared.pending_signal.0.send(()).ok();
                return;
            }
            link.writer = None; // broken pipe: the engine thread restarts the server
            self.shared.live.lock().unit(req.par_id).cost.cancel_trial(Instant::now());
        }
        drop(link);
        self.shared.pending.lock().insert(req.par_id, req);
        self.shared.pending_signal.0.send(()).ok();
    }

    fn note_bg_change(&self, rel_path: &str, rev: Revision, outcome: &EditOutcome) {
        let files = self.shared.files.lock();
        let line = files
            .get(rel_path)
            .and_then(|fb| {
                outcome
                    .touched
                    .iter()
                    .chain(outcome.added.iter())
                    .filter_map(|id| fb.span(*id))
                    .map(|s| fb.line_range(s).0)
                    .min()
            })
            .unwrap_or(0);
        self.shared
            .bg_change
            .lock()
            .entry(rel_path.to_string())
            .or_default()
            .push((rev, line));
    }

    /// A pass now, without waiting for the writer to pause (a host's explicit request).
    pub fn request_layout(&self) {
        self.mark_stale();
        self.shared.pass_now();
    }

    /// Defer background passes (they run when resumed). The fast path keeps working.
    pub fn pause_background(&self, paused: bool) {
        self.shared.bg_paused.store(paused, Ordering::SeqCst);
        if !paused
            && self
                .shared
                .bg_pending_while_paused
                .swap(false, Ordering::SeqCst)
        {
            self.shared.need_pass();
        }
    }

    fn schedule_background(&self) {
        self.mark_stale();
        self.shared.need_pass();
    }

    fn mark_stale(&self) {
        *self.shared.convergence.lock() = Some(Convergence::Stale {
            pending_since: self.shared.source_revision.load(Ordering::SeqCst),
        });
    }

    /// Load from disk every file the tracked files now `\input` that is not tracked yet.
    /// Returns the number of files added.
    fn load_new_inputs(&self) -> usize {
        let mut files = self.shared.files.lock();
        let envs: Vec<String> = self
            .shared
            .policy
            .lock()
            .theorem_envs
            .iter()
            .cloned()
            .collect();
        let mut added = 0;
        loop {
            let wanted: Vec<String> = files
                .values()
                .flat_map(|fb| crate::document::input_targets(&fb.text))
                .filter(|t| !files.contains_key(t))
                .collect();
            if wanted.is_empty() || files.len() > 256 {
                break;
            }
            let mut any = false;
            for rel in wanted {
                if files.contains_key(&rel) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(self.shared.cfg.project_root.join(&rel))
                else {
                    // Leave missing inputs absent so TeX reports them; a later create can load them.
                    continue;
                };
                let rev = self.shared.source_revision.load(Ordering::SeqCst);
                files.insert(
                    rel,
                    FileBuf::with_block_envs(&text, &mut self.shared.ids.lock(), rev, envs.clone()),
                );
                added += 1;
                any = true;
            }
            if !any {
                break;
            }
        }
        if added > 0 {
            *self.shared.inputted.lock() = crate::document::inputted_files(&texts_of(&files));
        }
        added
    }

    pub fn export_pdf(&self, out: impl Into<PathBuf>) -> u64 {
        let job = self.shared.edit_counter.fetch_add(1, Ordering::SeqCst) + 1;
        self.shared
            .bg_signal
            .0
            .send(BgCmd::Export(job, out.into()))
            .ok();
        job
    }

    /// Put an event back at the front of the queue (used by the C ABI's one-at-a-time poll).
    pub fn requeue(&self, e: Event) {
        self.requeued.lock().push_back(e);
    }

    /// Drain available events, waiting up to `timeout` for the first one.
    pub fn poll(&self, timeout: Duration) -> Vec<Event> {
        let mut v: Vec<Event> = self.requeued.lock().drain(..).collect();
        if v.is_empty() {
            if let Ok(e) = self.events.recv_timeout(timeout) {
                v.push(e);
            }
        }
        while let Ok(e) = self.events.try_recv() {
            v.push(e);
        }
        v
    }

    /// Wait for the first event matching `pred` (others are kept in order in the returned vec).
    pub fn wait_for(
        &self,
        timeout: Duration,
        mut pred: impl FnMut(&Event) -> bool,
    ) -> (Option<Event>, Vec<Event>) {
        let deadline = Instant::now() + timeout;
        let mut others = Vec::new();
        let queued: Vec<Event> = self.requeued.lock().drain(..).collect();
        for e in queued {
            if pred(&e) {
                return (Some(e), others);
            }
            others.push(e);
        }
        loop {
            let now = Instant::now();
            if now >= deadline {
                return (None, others);
            }
            match self.events.recv_timeout(deadline - now) {
                Ok(e) => {
                    if pred(&e) {
                        return (Some(e), others);
                    }
                    others.push(e);
                }
                Err(_) => return (None, others),
            }
        }
    }

    pub fn close(mut self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.shared.pending_signal.0.send(()).ok();
        self.shared.bg_signal.0.send(BgCmd::Quit).ok();
        for t in self.threads.drain(..) {
            let _ = t.join();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        self.shared.pending_signal.0.send(()).ok();
        self.shared.bg_signal.0.send(BgCmd::Quit).ok();
    }
}

fn reason_str(r: &Reason) -> String {
    match r {
        Reason::DisallowedMacro(m) => format!("macro \\{m}"),
        Reason::DisallowedMathMacro(m) => format!("math macro \\{m}"),
        Reason::SizeDeclarationOutsideGroup(m) => format!("\\{m} outside group"),
        Reason::EngineFlag(s) => format!("engine {s}"),
        Reason::OverBudget(ms) => {
            format!("OverBudget: live service {ms} ms; deferred after repeated latency losses")
        }
        other => format!("{other:?}"),
    }
}

/// The first line of a (multi-line) message, such as a Lua error with its traceback.
fn first_line_of(msg: &str) -> &str {
    msg.lines().next().unwrap_or("")
}

#[cfg(test)]
mod unfinished_tests {
    use super::*;

    #[test]
    fn incomplete_math_waits_only_without_other_background_reasons() {
        assert!(unfinished_only(&["IncompleteMath".into()]));
        assert!(unfinished_only(&["IncompleteCommand".into()]));
        assert!(unfinished_only(&["IncompleteMath".into(), "NoContext".into()]));
        assert!(!unfinished_only(&["IncompleteMath".into(), "KindMismatch".into()]));
        assert!(!unfinished_only(&["NoContext".into()]));
        assert!(!unfinished_only(&[]));
    }

    #[test]
    fn incomplete_math_is_not_probed_as_a_healthy_snapshot() {
        let policy = Policy::default();
        for text in [r"$\left( a$", r"$\frac{a}$", "$x^$"] {
            assert!(structurally_unfinished(text, &policy), "{text}");
        }
        for text in [r"$\left( a\right)$", r"$\frac12$", "$x^2$"] {
            assert!(!structurally_unfinished(text, &policy), "{text}");
        }
    }
}
