//! When the background pass runs. A pass typesets the whole document, so it waits for the
//! writer to pause instead of starting while keystrokes still arrive. A span refused only
//! because a structure in it is still being typed (an unclosed `$`, `\[`, `\begin{..}` or
//! brace), or whose live compile reported a TeX error, asks for no pass of its own at first:
//! its live overlay or layout rows stay as they were, and the pass runs only once the span has
//! been left that way for a while (the writer stopped there: a real error to show and report),
//! or when something else needs one. Every wait is bounded.

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use crate::document::ParaId;

/// The scheduler's delays (see `SessionConfig`).
#[derive(Debug, Clone, Copy)]
pub struct PassTiming {
    /// Quiet time (no edit, no new request) a needed pass waits for.
    pub debounce: Duration,
    /// A needed pass runs at the latest this long after it was first asked for.
    pub max_wait: Duration,
    /// An unfinished structure asks for a pass once it has not been edited for this long.
    pub settle: Duration,
    /// ... or, while it keeps being edited unfinished, this long after it first was.
    pub settle_max: Duration,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Wait {
    /// Start the pass.
    Run,
    /// Nothing asks for a pass any more (an unfinished structure was completed live).
    Nothing,
    /// Check again after this long (or when a new request arrives).
    For(Duration),
}

/// What the next background pass is for. Requests coalesce: one pass answers all of them.
#[derive(Debug, Default)]
pub struct PassWish {
    /// A pass is needed (boundaries changed, rows or counters moved, a span refused for good,
    /// a demotion, a stale layout): since when.
    needed: Option<Instant>,
    /// Without waiting: the host asked (`request_layout`), or no layout exists yet.
    now: bool,
    /// Spans refused only for an unfinished structure (or with a live TeX error).
    unfinished: BTreeSet<ParaId>,
    /// Since when spans have been left unfinished, and when one was last: an episode goes on
    /// while such edits come less than the settle time apart, even when a keystroke in between
    /// was typeset live, so `settle_max` bounds it.
    unfinished_since: Option<Instant>,
    unfinished_edit: Option<Instant>,
    /// Spans in an unfinished episode, kept across a pass that showed them unfinished: a span
    /// still open after it is still being typed, not a structure the scan always refuses.
    episode: BTreeSet<ParaId>,
    /// An edit since the pass started that was more than an unfinished structure growing: a
    /// pass that finds the source moved on catches up only then.
    changed: bool,
    /// A pass is running (taken and not finished).
    running: bool,
    /// A pass delivered a layout the source had moved past while only unfinished structures
    /// grew: once none is left unfinished (completed live), a catch-up pass is due.
    stale_owed: bool,
    /// The last edit of any kind and the last request: the quiet a needed pass waits for.
    last_edit: Option<Instant>,
    last_request: Option<Instant>,
}

impl PassWish {
    pub fn need(&mut self, at: Instant) {
        self.needed.get_or_insert(at);
        self.last_request = Some(at);
    }

    pub fn now(&mut self) {
        self.now = true;
    }

    /// An edit. `changed`: more than an unfinished structure growing (see `changed`).
    pub fn edited(&mut self, at: Instant, changed: bool) {
        self.last_edit = Some(at);
        self.changed |= changed;
    }

    /// `id` was refused only because a structure in it is unfinished, or its live compile
    /// reported an error.
    pub fn unfinished(&mut self, id: ParaId, at: Instant, settle: Duration) {
        let fresh = self
            .unfinished_edit
            .is_none_or(|last| at.saturating_duration_since(last) >= settle);
        if fresh || self.unfinished_since.is_none() {
            self.unfinished_since = Some(at);
        }
        self.unfinished.insert(id);
        self.episode.insert(id);
        self.unfinished_edit = Some(at);
    }

    /// `id` is no longer unfinished (typeset live, refused for another reason, or gone).
    /// True when that leaves a catch-up pass due (`owe_stale`): the caller wakes the scheduler.
    pub fn settled(&mut self, id: ParaId, at: Instant) -> bool {
        self.unfinished.remove(&id);
        self.episode.remove(&id);
        if self.stale_owed && self.unfinished.is_empty() {
            self.stale_owed = false;
            self.need(at);
            return true;
        }
        false
    }

    /// A live result of an unfinished span came back clean: when nothing else is unfinished,
    /// the next unfinished structure starts its own settle window.
    pub fn completed(&mut self) {
        if self.unfinished.is_empty() {
            self.unfinished_since = None;
            self.unfinished_edit = None;
        }
    }

    /// See `stale_owed`.
    pub fn owe_stale(&mut self) {
        self.stale_owed = true;
    }

    /// `id` was left unfinished by an earlier edit and is still being typed.
    pub fn in_episode(&self, id: ParaId) -> bool {
        self.episode.contains(&id)
    }

    /// A pass is running, wanted, or will be once the unfinished spans settle.
    pub fn pending(&self) -> bool {
        self.running
            || self.now
            || self.needed.is_some()
            || self.stale_owed
            || !self.unfinished.is_empty()
    }

    /// Edits since the pass started changed more than unfinished structures.
    pub fn changed(&self) -> bool {
        self.changed
    }

    /// The pass starts: its snapshot answers every request so far (unfinished spans included:
    /// the pass shows and reports them as TeX sees them). Running from here on.
    pub fn take(&mut self) {
        *self = PassWish {
            running: true,
            episode: std::mem::take(&mut self.episode),
            unfinished_edit: self.unfinished_edit,
            last_edit: self.last_edit,
            ..PassWish::default()
        };
    }

    /// The pass delivered its result.
    pub fn done(&mut self) {
        self.running = false;
    }

    pub fn wait(&self, t: &PassTiming, now: Instant) -> Wait {
        if self.now {
            return Wait::Run;
        }
        let unfinished = (!self.unfinished.is_empty())
            .then_some(self.unfinished_edit)
            .flatten()
            .map(|edit| {
                let since = self.unfinished_since.unwrap_or(edit);
                (edit + t.settle).min(since + t.settle_max)
            });
        let deadline = match (self.needed, unfinished) {
            (Some(since), unfinished) => {
                let last = [self.last_edit, self.last_request, Some(since)]
                    .into_iter()
                    .flatten()
                    .max()
                    .unwrap_or(since);
                // what a pass would compile now still has a structure being typed: wait for it
                // to settle too, never past the needed pass's own bound
                let quiet = (last + t.debounce).max(unfinished.unwrap_or(now));
                quiet.min(since + t.max_wait)
            }
            (None, Some(at)) => at,
            (None, None) => return Wait::Nothing,
        };
        match deadline.checked_duration_since(now) {
            Some(d) if !d.is_zero() => Wait::For(d),
            _ => Wait::Run,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: PassTiming = PassTiming {
        debounce: Duration::from_millis(300),
        max_wait: Duration::from_secs(2),
        settle: Duration::from_millis(2000),
        settle_max: Duration::from_secs(8),
    };

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn a_needed_pass_waits_for_quiet_within_its_bound() {
        let t0 = Instant::now();
        let mut w = PassWish::default();
        assert_eq!(w.wait(&T, t0), Wait::Nothing);
        w.need(t0);
        assert_eq!(w.wait(&T, t0), Wait::For(ms(300)));
        // typing continues: the pass keeps waiting for a pause
        w.edited(t0 + ms(200), true);
        assert_eq!(w.wait(&T, t0 + ms(300)), Wait::For(ms(200)));
        assert_eq!(w.wait(&T, t0 + ms(500)), Wait::Run);
        // ... but not past its bound
        w.edited(t0 + ms(1900), true);
        assert_eq!(w.wait(&T, t0 + ms(1950)), Wait::For(ms(50)));
        assert_eq!(w.wait(&T, t0 + ms(2000)), Wait::Run);
        w.take();
        assert!(w.pending(), "running");
        assert!(!w.changed());
        w.done();
        assert!(!w.pending());
        assert_eq!(w.wait(&T, t0 + ms(2000)), Wait::Nothing);
    }

    #[test]
    fn host_requests_run_at_once() {
        let t0 = Instant::now();
        let mut w = PassWish::default();
        w.edited(t0, true);
        w.now();
        assert_eq!(w.wait(&T, t0), Wait::Run);
    }

    #[test]
    fn an_unfinished_structure_waits_to_settle_and_completing_it_cancels() {
        let t0 = Instant::now();
        let id = ParaId(7);
        let mut w = PassWish::default();
        w.unfinished(id, t0, T.settle);
        assert_eq!(w.wait(&T, t0 + ms(500)), Wait::For(ms(1500)));
        w.unfinished(id, t0 + ms(1000), T.settle);
        assert_eq!(w.wait(&T, t0 + ms(2000)), Wait::For(ms(1000)));
        assert!(w.pending() && w.in_episode(id));
        // the closing delimiter typed live: nothing to compile
        assert!(!w.settled(id, t0 + ms(2000)));
        w.completed();
        assert!(!w.pending() && !w.in_episode(id));
        assert_eq!(w.wait(&T, t0 + ms(2000)), Wait::Nothing);
        // left unfinished, after a pause: a new episode, reported after the settle time
        w.unfinished(id, t0 + ms(5000), T.settle);
        assert_eq!(w.wait(&T, t0 + ms(7000)), Wait::Run);
        // the pass shows it unfinished; it is still being typed afterwards
        w.take();
        assert!(w.in_episode(id));
    }

    #[test]
    fn edited_unfinished_without_end_runs_after_the_bound() {
        let t0 = Instant::now();
        let id = ParaId(1);
        let mut w = PassWish::default();
        for k in 0..100u64 {
            w.unfinished(id, t0 + ms(k * 100), T.settle);
        }
        assert_eq!(w.wait(&T, t0 + ms(8000)), Wait::Run);
    }

    #[test]
    fn a_live_error_typed_on_stays_bounded() {
        // every keystroke is typeset live (settled) and comes back with an error (unfinished)
        let t0 = Instant::now();
        let id = ParaId(4);
        let mut w = PassWish::default();
        for k in 0..100u64 {
            w.settled(id, t0 + ms(k * 500));
            w.unfinished(id, t0 + ms(k * 500), T.settle);
        }
        assert_eq!(w.wait(&T, t0 + ms(8000)), Wait::Run);
    }

    #[test]
    fn completing_a_structure_live_starts_the_next_settle_window_afresh() {
        // dense inline math: each formula closed live within a second, prose in between
        let t0 = Instant::now();
        let id = ParaId(5);
        let mut w = PassWish::default();
        for k in 0..5u64 {
            let open = t0 + ms(k * 1700);
            w.unfinished(id, open, T.settle);
            w.unfinished(id, open + ms(800), T.settle);
            w.settled(id, open + ms(1000));
            w.completed();
        }
        // the formula open now was opened 0.3 s ago: no pass on it at the session's 8 s mark
        let open = t0 + ms(8500);
        w.unfinished(id, open, T.settle);
        assert_eq!(w.wait(&T, t0 + ms(8800)), Wait::For(ms(1700)));
        // kept open and edited: bounded from its own start
        for k in 1..=60u64 {
            w.unfinished(id, open + ms(k * 150), T.settle);
        }
        assert_eq!(w.wait(&T, open + ms(8000)), Wait::Run);
    }

    #[test]
    fn edits_that_only_grow_unfinished_structures_do_not_count_as_changed() {
        let t0 = Instant::now();
        let mut w = PassWish::default();
        w.take();
        w.edited(t0, false);
        assert!(!w.changed());
        w.edited(t0 + ms(10), true);
        assert!(w.changed());
        // a pass asked for while one runs stays pending after it
        w.need(t0 + ms(20));
        w.done();
        assert!(w.pending());
        assert_eq!(w.wait(&T, t0 + ms(400)), Wait::Run);
    }

    #[test]
    fn a_stale_layout_is_caught_up_once_the_unfinished_structure_is_closed() {
        let t0 = Instant::now();
        let id = ParaId(9);
        let mut w = PassWish::default();
        w.take();
        w.unfinished(id, t0, T.settle);
        w.edited(t0, false);
        w.done();
        // the pass delivered stale; only the unfinished structure moved
        w.owe_stale();
        assert!(w.pending());
        // closed live: the catch-up is now due (after the usual quiet)
        assert!(w.settled(id, t0 + ms(500)));
        assert!(w.pending());
        assert_eq!(w.wait(&T, t0 + ms(500)), Wait::For(ms(300)));
    }

    #[test]
    fn a_needed_pass_waits_for_an_unfinished_structure_within_its_bound() {
        let t0 = Instant::now();
        let mut w = PassWish::default();
        w.need(t0);
        w.unfinished(ParaId(3), t0 + ms(100), T.settle);
        w.edited(t0 + ms(100), false);
        // quiet after 400 ms, but the structure settles only at 2.1 s; the bound is 2 s
        assert_eq!(w.wait(&T, t0 + ms(400)), Wait::For(ms(1600)));
        assert_eq!(w.wait(&T, t0 + ms(2000)), Wait::Run);
    }
}
