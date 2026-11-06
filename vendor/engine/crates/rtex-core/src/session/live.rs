//! What the live path records per span between layouts, in one record per span with one place
//! that decides when each fact expires. Before, each fact was a map of its own with its own
//! clearing rule, spread over the session; a fact cleared in one place and kept in another is
//! the stale-state bug this module exists to prevent.
//!
//! Fact lifetimes:
//! - **until the next layout** (`on_new_layout`): what the live path guessed and the pass now
//!   knows — live rows and placement confirmed by that snapshot, and the counters seen. Newer
//!   painted ink stays recorded until a snapshot includes it. A borrowed context lasts
//!   until a layout includes its unit, provided both anchors still have captured positions;
//! - **for one layout version** (tagged; other versions are ignored and dropped at the next
//!   layout): a probe verdict or an internal error. A verified verdict
//!   carries over a layout that typeset the unit broken (a structure still being typed, or a
//!   TeX error the live engine reported too): that snapshot gives the probe nothing to compare
//!   with;
//! - **until the preamble changes** (`on_preamble_change`): a leaked definition, bounded
//!   recovery history after the unit hung or crashed the engine, and bounded cost samples.

use super::*;

const RECOVERY_COOLDOWN: Duration = Duration::from_secs(1);
/// Initial failure plus two attempts on changed text, across layouts and successful edits.
const RECOVERY_FAILURE_LIMIT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RecoveryGate {
    Ready,
    Wait(Duration),
    Blocked(&'static str),
}

/// Failed content is never repeated automatically. Changed content gets a bounded chance on
/// the replacement server, after a cooldown; changing it on every keystroke cannot reset the
/// failure budget. A clean result leaves this history in place until the preamble changes.
#[derive(Debug, Default)]
pub(super) struct CrashRecovery {
    failed_hashes: Vec<u64>,
    /// Probes compile an older layout snapshot, not the current request's content.
    failed_probe_hashes: Vec<u64>,
    retry_after: Option<Instant>,
    diagnostic_pending: bool,
}

impl CrashRecovery {
    pub fn failed(&mut self, hash: u64, now: Instant) {
        if !self.failed_hashes.contains(&hash) && self.failures() < RECOVERY_FAILURE_LIMIT {
            self.failed_hashes.push(hash);
        }
        self.retry_after = Some(now + RECOVERY_COOLDOWN);
    }

    pub fn failed_probe(&mut self, hash: u64, now: Instant) {
        if !self.failed_probe_hashes.contains(&hash) && self.failures() < RECOVERY_FAILURE_LIMIT {
            self.failed_probe_hashes.push(hash);
        }
        self.retry_after = Some(now + RECOVERY_COOLDOWN);
    }

    fn failures(&self) -> usize {
        self.failed_hashes.len() + self.failed_probe_hashes.len()
    }

    pub fn gate(&self, hash: u64, now: Instant) -> RecoveryGate {
        if self.failed_hashes.contains(&hash) {
            return RecoveryGate::Blocked("EngineFailed: this version hung or crashed the live engine; edit the paragraph to retry");
        }
        self.budget_gate(now)
    }

    pub fn probe_gate(&self, hash: u64, now: Instant) -> RecoveryGate {
        if self.failed_probe_hashes.contains(&hash) {
            return RecoveryGate::Blocked("EngineFailed: this layout snapshot hung or crashed during the live probe; a fresh full compile is needed");
        }
        self.budget_gate(now)
    }

    fn budget_gate(&self, now: Instant) -> RecoveryGate {
        if self.failures() >= RECOVERY_FAILURE_LIMIT {
            return RecoveryGate::Blocked("EngineFailed: automatic recovery attempts are exhausted; this paragraph stays on the full compile until the preamble changes");
        }
        match self
            .retry_after
            .and_then(|at| at.checked_duration_since(now))
        {
            Some(wait) if !wait.is_zero() => RecoveryGate::Wait(wait),
            _ => RecoveryGate::Ready,
        }
    }

    /// A clean replacement result clears the failure diagnostic, but does not forgive
    /// failed hashes or replenish the automatic retry budget.
    pub fn succeeded(&mut self) -> bool {
        std::mem::take(&mut self.diagnostic_pending)
    }

    pub fn reported(&mut self) {
        self.diagnostic_pending = true;
    }
}

#[derive(Debug)]
pub(super) struct PaintedRows {
    pub layout_version: u64,
    pub revision: Revision,
    pub ink: Vec<RowBox>,
    geometry: DisplayList,
}

impl PaintedRows {
    pub fn new(version: u64, revision: Revision, dl: &DisplayList, fragments: &[Fragment]) -> Option<Self> {
        Some(Self {
            layout_version: version, revision, ink: LayoutStore::placed_rows(dl, fragments)?,
            // Reanchoring needs row geometry, never another copy of glyphs or resources.
            geometry: DisplayList { lines: dl.lines.iter().map(|row| rtex_dl::Line {
                x: row.x, y: row.y, w: row.w, h: row.h, d: row.d, ..Default::default()
            }).collect(), ..Default::default() },
        })
    }

    fn reanchor(&mut self, id: ParaId, layout: &LayoutStore) {
        let rows: Vec<_> = self.geometry.lines.iter().map(|row| (row.x, row.y)).collect();
        if let Some((fragments, _)) = layout.fragments(id, &rows) {
            let Some(ink) = LayoutStore::placed_rows(&self.geometry, &fragments) else { return; };
            self.ink = ink;
        }
        // With no new placement the preview keeps its previous fragments too.
        self.layout_version = layout.layout_version;
    }
}

#[derive(Debug, Default)]
pub(super) struct LiveUnit {
    // --- until the next layout ---
    /// Compiled on a borrowed context: (unit the context came from, span the rows are placed
    /// against, whether they follow it).
    pub derived: Option<(ParaId, ParaId, bool)>,
    /// Row count of the latest live result (anchors a unit placed after it).
    pub rows: Option<i64>,
    /// Where the latest live result was placed: (page, x of its first row, its last baseline);
    /// a unit typed after it on a borrowed context chains onto it.
    pub place: Option<(i64, i64, i64)>,
    /// Published ink follows the same reanchoring as the preview on a stale layout.
    pub painted: Option<PaintedRows>,
    /// Counters the latest live compile advanced (a change renumbers what follows: pass).
    pub counters: Option<BTreeMap<String, i64>>,
    // --- until a clean live result ---
    /// The latest live compile reported a TeX error: the live engine agrees with a full compile
    /// that the unit's text is broken.
    pub live_error: bool,
    // --- for one layout version ---
    /// Probe verdict (probe mode): (layout version, verdict).
    pub probe: Option<(u64, ProbeVerdict)>,
    /// Performance history survives unrelated layouts and ordinary source edits.
    pub cost: LiveCost,
    pub measured_once: bool,
    /// A Lua error of the server's own on this unit: (layout version, message). The unit waits
    /// for the pass until the next layout, then gets another chance.
    pub internal_error: Option<(u64, String)>,
    // --- until the preamble changes ---
    /// The compile changed the meaning of a control sequence (a definition leaked).
    pub leak: Option<String>,
    /// Content hashes that failed, and the cooldown/budget for automatic recovery.
    pub recovery: Option<CrashRecovery>,
    /// A speculative font warm-up failed: do not repeat warm-ups of this unit until the
    /// preamble changes. Real edits still qualify normally and have their own retry budget.
    pub warmup_failed: bool,
}

impl LiveUnit {
    fn is_empty(&self) -> bool {
        self.derived.is_none()
            && self.rows.is_none()
            && self.place.is_none()
            && self.painted.is_none()
            && self.counters.is_none()
            && !self.live_error
            && self.probe.is_none()
            && self.cost.is_empty()
            && !self.measured_once
            && self.internal_error.is_none()
            && self.leak.is_none()
            && self.recovery.is_none()
            && !self.warmup_failed

    }
}

/// The live records of all spans (one mutex in `Shared`; take it for short, non-nested scopes).
#[derive(Debug, Default)]
pub(super) struct LiveUnits(HashMap<ParaId, LiveUnit>);

impl LiveUnits {
    pub fn get(&self, id: ParaId) -> Option<&LiveUnit> {
        self.0.get(&id)
    }

    /// The record of `id`, created empty when there is none.
    pub fn unit(&mut self, id: ParaId) -> &mut LiveUnit {
        self.0.entry(id).or_default()
    }

    pub fn recovery_gate(&self, id: ParaId, hash: u64, now: Instant) -> RecoveryGate {
        self.get(id)
            .and_then(|u| u.recovery.as_ref())
            .map_or(RecoveryGate::Ready, |r| r.gate(hash, now))
    }

    /// Direct dispatch must leave cooldown requests queued for the engine thread.
    pub fn recovery_ready(&self, id: ParaId, hash: u64, now: Instant) -> bool {
        self.recovery_gate(id, hash, now) == RecoveryGate::Ready
    }

    pub fn probe_recovery_gate(&self, id: ParaId, hash: u64, now: Instant) -> RecoveryGate {
        self.get(id)
            .and_then(|u| u.recovery.as_ref())
            .map_or(RecoveryGate::Ready, |r| r.probe_gate(hash, now))
    }

    /// The probe verdict of `id` for layout `lv`.
    pub fn probe_for(&self, id: ParaId, lv: u64) -> Option<ProbeVerdict> {
        self.get(id)?
            .probe
            .as_ref()
            .filter(|(v, _)| *v == lv)
            .map(|(_, p)| p.clone())
    }

    /// The internal error of `id` recorded for layout `lv`.
    pub fn internal_error_for(&self, id: ParaId, lv: u64) -> Option<String> {
        self.get(id)?
            .internal_error
            .as_ref()
            .filter(|(v, _)| *v == lv)
            .map(|(_, m)| m.clone())
    }

    /// Is `id` compiled on a borrowed context?
    pub fn is_derived(&self, id: ParaId) -> bool {
        self.get(id).is_some_and(|u| u.derived.is_some())
    }

    /// A layout was installed: the pass's placements and contexts supersede what
    /// the live path guessed, and facts tagged with an older layout no longer apply, except
    /// the verified verdicts of `broken` units (the layout typeset them with an error or an
    /// unfinished structure: compiling that snapshot proves nothing).
    pub fn on_new_layout(
        &mut self,
        layout: &LayoutStore,
        current: &HashSet<ParaId>,
        broken: &HashSet<ParaId>,
    ) {
        let lv = layout.layout_version;
        for (id, u) in self.0.iter_mut() {
            // A stale pass cannot replace a newer paragraph; retain only valid captured anchors.
            let keep_derived = current.contains(id)
                && layout.snapshot_span(*id).is_none()
                && u.derived.is_some_and(|(parent, anchor, _)| {
                    current.contains(&parent)
                        && current.contains(&anchor)
                        && layout.unit(parent).is_some()
                        && layout.unit(anchor).is_some()
                });
            if !keep_derived {
                u.derived = None;
            }
            u.rows = None;
            u.place = None;
            if u.painted.as_ref().is_none_or(|painted| painted.revision <= layout.snapshot_revision) {
                u.painted = None;
            } else if let Some(painted) = &mut u.painted {
                painted.reanchor(*id, layout);
            }
            u.counters = None;
            match &mut u.probe {
                Some((v, ProbeVerdict::Verified)) if broken.contains(id) => *v = lv,
                Some((v, _)) if *v != lv => u.probe = None,
                _ => {}
            }
            if !current.contains(id) {
                u.cost = LiveCost::default();
                u.measured_once = false;
                u.painted = None;
            }
            if u.internal_error.as_ref().is_some_and(|(v, _)| *v != lv) {
                u.internal_error = None;
            }
        }
        self.prune();
    }

    /// The running server was replaced by one with the same preamble and newer bibliography
    /// data: probe verdicts compared that server's output, the rest still holds.
    pub fn on_server_swap(&mut self) {
        for u in self.0.values_mut() {
            u.probe = None;
            u.measured_once = false;
        }
    }

    pub fn on_server_replacement(&mut self) {
        for u in self.0.values_mut() {
            u.measured_once = false;
        }
    }

    /// The preamble changed: the engine restarts, so verdicts, budget marks, recovery history and
    /// leaks about the old engine no longer apply.
    pub fn on_preamble_change(&mut self) {
        for u in self.0.values_mut() {
            u.probe = None;
            u.cost = LiveCost::default();
            u.measured_once = false;
            u.painted = None;
            u.leak = None;
            u.recovery = None;
            u.warmup_failed = false;
        }
        self.prune();
    }

    fn prune(&mut self) {
        self.0.retain(|_, u| !u.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stale_layout_cannot_forget_unconfirmed_painted_ink() {
        let mut live = LiveUnits::default();
        let id = ParaId(1);
        let dl = DisplayList { lines: vec![rtex_dl::Line {
            w: 80, h: 20, d: 45, ..Default::default()
        }], ..Default::default() };
        live.unit(id).painted = PaintedRows::new(5, 3, &dl, &LayoutStore::fragments_at(1, 0, 100, &[(0, 0)]));
        let mut layout = LayoutStore::default();
        layout.layout_version = 6;
        layout.snapshot_revision = 1;
        live.on_new_layout(&layout, &HashSet::from([id]), &HashSet::new());
        assert!(live.get(id).unwrap().painted.is_some(), "the host still displays newer ink after a stale pass");
        layout.snapshot_revision = 3;
        live.on_new_layout(&layout, &HashSet::from([id]), &HashSet::new());
        assert!(live.get(id).is_none_or(|u| u.painted.is_none()));
    }

    #[test]
    fn expiry_rules() {
        let mut l = LiveUnits::default();
        let a = ParaId(1);
        let b = ParaId(2);
        {
            let u = l.unit(a);
            u.derived = Some((b, b, true));
            u.rows = Some(3);
            u.place = Some((1, 2, 3));
            u.probe = Some((5, ProbeVerdict::Verified));
            for _ in 0..3 {
                u.cost.record(Duration::from_millis(1500), Duration::from_millis(50), Some(Duration::from_millis(1300)), false, Instant::now());
            }
            u.internal_error = Some((5, "e".into()));
            u.leak = Some("\\x".into());

        }
        l.unit(b)
            .recovery
            .get_or_insert_default()
            .failed(42, Instant::now());
        assert!(l.is_derived(a));
        assert!(l.probe_for(a, 5).is_some() && l.probe_for(a, 4).is_none());
        assert_eq!(l.internal_error_for(a, 5).as_deref(), Some("e"));
        // the same layout version installed again keeps the version-tagged facts
        let mut layout = LayoutStore::default();
        layout.layout_version = 5;
        l.on_new_layout(&layout, &HashSet::from([a, b]), &HashSet::new());
        assert!(!l.is_derived(a) && l.get(a).unwrap().rows.is_none());
        assert!(l.probe_for(a, 5).is_some());
        assert!(!l.get(a).unwrap().cost.allows(Instant::now()));
        // a newer layout drops them; recovery history, leak and strikes stay
        layout.layout_version = 6;
        l.on_new_layout(&layout, &HashSet::from([a, b]), &HashSet::new());
        let u = l.get(a).unwrap();
        assert!(u.probe.is_none() && !u.cost.allows(Instant::now()) && u.internal_error.is_none());
        assert!(u.leak.is_some());
        assert!(matches!(
            l.recovery_gate(b, 42, Instant::now()),
            RecoveryGate::Blocked(_)
        ));
        // a preamble change clears recovery history and leaks; strikes stay; empty records go
        l.on_preamble_change();
        assert!(l.get(b).is_none(), "empty record pruned");
        assert!(l.get(a).is_none_or(|u| u.leak.is_none() && u.cost.is_empty()));
    }

    #[test]
    fn recovery_never_repeats_failed_content_and_waits_before_changed_content() {
        let now = Instant::now();
        let mut r = CrashRecovery::default();
        r.failed(11, now);
        assert!(matches!(
            r.gate(11, now + Duration::from_secs(60)),
            RecoveryGate::Blocked(_)
        ));
        assert_eq!(r.gate(12, now), RecoveryGate::Wait(RECOVERY_COOLDOWN));
        assert_eq!(r.gate(12, now + RECOVERY_COOLDOWN), RecoveryGate::Ready);
    }

    #[test]
    fn changed_content_and_layouts_cannot_reset_the_recovery_budget() {
        let now = Instant::now();
        let id = ParaId(1);
        let mut live = LiveUnits::default();
        for n in 0..RECOVERY_FAILURE_LIMIT {
            let at = now + RECOVERY_COOLDOWN * n as u32;
            live.unit(id)
                .recovery
                .get_or_insert_default()
                .failed(n as u64, at);
            let mut layout = LayoutStore::default();
            layout.layout_version = n as u64 + 1;
            live.on_new_layout(&layout, &HashSet::new(), &HashSet::new());
            live.on_server_swap();
        }
        assert!(matches!(
            live.recovery_gate(id, 99, now + Duration::from_secs(60)),
            RecoveryGate::Blocked(_)
        ));
        live.on_preamble_change();
        assert!(live.recovery_ready(id, 99, now));
    }

    #[test]
    fn successful_recovery_clears_the_diagnostic_but_preserves_failed_hashes_and_budget() {
        let now = Instant::now();
        let mut r = CrashRecovery::default();
        r.failed(1, now);
        r.reported();
        assert_eq!(r.gate(2, now + RECOVERY_COOLDOWN), RecoveryGate::Ready);
        assert!(r.succeeded());
        assert!(!r.succeeded(), "clear the failure diagnostic only once");
        assert!(matches!(
            r.gate(1, now + RECOVERY_COOLDOWN),
            RecoveryGate::Blocked(_)
        ));
        r.failed(2, now + RECOVERY_COOLDOWN);
        r.failed(3, now + RECOVERY_COOLDOWN * 2);
        assert!(matches!(
            r.gate(4, now + Duration::from_secs(60)),
            RecoveryGate::Blocked(_)
        ));
    }

    #[test]
    fn probe_failures_track_the_snapshot_separately_and_share_the_retry_limit() {
        let now = Instant::now();
        let mut r = CrashRecovery::default();
        r.failed_probe(10, now);
        let later = now + Duration::from_secs(60);
        assert_eq!(
            r.gate(10, later),
            RecoveryGate::Ready,
            "a probe hash must not label current source bytes as failed"
        );
        assert!(matches!(r.probe_gate(10, later), RecoveryGate::Blocked(_)));
        assert_eq!(r.probe_gate(20, later), RecoveryGate::Ready);
        r.failed(30, now);
        r.failed_probe(40, now);
        assert!(matches!(r.gate(50, later), RecoveryGate::Blocked(_)));
        assert!(matches!(r.probe_gate(50, later), RecoveryGate::Blocked(_)));
    }

    #[test]
    fn a_verified_unit_stays_verified_across_a_layout_that_typeset_it_broken() {
        let mut l = LiveUnits::default();
        let (a, b, c) = (ParaId(1), ParaId(2), ParaId(3));
        l.unit(a).probe = Some((5, ProbeVerdict::Verified));
        l.unit(b).probe = Some((5, ProbeVerdict::Mismatch("rows".into())));
        l.unit(c).probe = Some((5, ProbeVerdict::Verified));
        let mut layout = LayoutStore::default();
        layout.layout_version = 6;
        l.on_new_layout(&layout, &HashSet::new(), &[a, b].into_iter().collect());
        assert!(matches!(l.probe_for(a, 6), Some(ProbeVerdict::Verified)));
        // a mismatch is never carried, nor a verdict of a unit the layout typeset cleanly
        assert!(l.get(b).is_none_or(|u| u.probe.is_none()));
        assert!(l.get(c).is_none_or(|u| u.probe.is_none()));
    }
}
