//! Bounded measurements of warm, uncontended, clean live compiles.
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
pub(super) struct Samples {
    values: [Duration; 3],
    len: usize,
    next: usize,
}

impl Samples {
    pub fn record(&mut self, service: Duration) {
        self.values[self.next] = service;
        self.next = (self.next + 1) % 3;
        self.len = (self.len + 1).min(3);
    }

    pub fn median(&self) -> Option<Duration> {
        if self.len < 3 {
            return None;
        }
        let mut values = self.values;
        values.sort_unstable();
        Some(values[1])
    }

    pub fn latest(&self) -> Option<Duration> {
        (self.len > 0).then(|| self.values[(self.next + 2) % 3])
    }
}

/// Keep this record across ordinary text edits and layouts; delete/reset it deliberately.
#[derive(Debug, Default)]
pub(super) struct LiveCost {
    samples: Samples,
    strikes: u8,
    retry_after: Option<Instant>,
    trial: bool,
}

impl LiveCost {
    /// Caller excludes cold starts, failures, and service overlapping a full pass.
    pub fn record(
        &mut self,
        service: Duration,
        target: Duration,
        full_estimate: Option<Duration>,
        blocked_others: bool,
        now: Instant,
    ) {
        if self.retry_after.is_some() && !self.trial {
            return;
        }
        self.samples.record(service);
        let no_benefit = service > target
            && (blocked_others || full_estimate.is_some_and(|full| service >= full));
        if std::mem::take(&mut self.trial) {
            self.strikes = 0;
            self.retry_after = no_benefit.then_some(now + Duration::from_secs(1));
        } else if no_benefit {
            self.strikes += 1;
            if self.strikes == 3 {
                self.strikes = 0;
                self.retry_after = Some(now + Duration::from_secs(1));
            }
        } else {
            self.strikes = 0;
        }
    }

    /// Cooldown expiry permits queuing; dispatch must reserve the idle trial below.
    pub fn allows(&self, now: Instant) -> bool {
        !self.trial && self.retry_after.is_none_or(|at| now >= at)
    }

    /// Caller dispatches only while idle; normal live work needs no reservation.
    pub fn begin_trial(&mut self, now: Instant) -> bool {
        if !self.allows(now) {
            return false;
        }
        if self.retry_after.is_some() {
            self.trial = true;
        }
        true
    }

    /// An unmeasurable completion releases the reservation without adding a sample.
    pub fn cancel_trial(&mut self, now: Instant) {
        if std::mem::take(&mut self.trial) {
            self.retry_after = Some(now + Duration::from_secs(1));
        }
    }

    pub fn is_empty(&self) -> bool {
        self.samples.len == 0
    }

    pub fn estimate(&self) -> Option<Duration> {
        self.samples.median()
    }

    pub fn is_deferred(&self) -> bool {
        self.retry_after.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TARGET: Duration = Duration::from_millis(50);
    const FULL: Option<Duration> = Some(Duration::from_millis(1300));

    fn observe(cost: &mut LiveCost, ms: u64, blocked: bool, now: Instant) {
        cost.record(Duration::from_millis(ms), TARGET, FULL, blocked, now);
    }

    fn deferred(now: Instant) -> LiveCost {
        let mut cost = LiveCost::default();
        for _ in 0..3 {
            observe(&mut cost, 1500, false, now);
        }
        assert!(!cost.allows(now));
        cost
    }

    #[test]
    fn median_requires_three_samples_and_keeps_only_the_latest_three() {
        let mut samples = Samples::default();
        assert_eq!(samples.median(), None);
        samples.record(Duration::from_millis(60));
        samples.record(Duration::from_millis(5000));
        assert_eq!(samples.median(), None);
        samples.record(Duration::from_millis(70));
        assert_eq!(samples.median(), Some(Duration::from_millis(70)));
        samples.record(Duration::from_millis(80));
        assert_eq!(samples.median(), Some(Duration::from_millis(80)));
        samples.record(Duration::from_millis(90));
        assert_eq!(samples.median(), Some(Duration::from_millis(80)));
        samples.record(Duration::from_millis(100));
        assert_eq!(samples.median(), Some(Duration::from_millis(90)));
    }

    #[test]
    fn a_full_layout_estimate_can_use_its_first_actual_measurement() {
        let mut samples = Samples::default();
        assert_eq!(samples.latest(), None);
        samples.record(Duration::from_millis(1300));
        assert_eq!(samples.latest(), Some(Duration::from_millis(1300)));
        assert_eq!(samples.median(), None);
    }

    #[test]
    fn sixty_ms_remains_live_when_a_full_pass_takes_thirteen_hundred_ms() {
        let now = Instant::now();
        let mut cost = LiveCost::default();
        for _ in 0..12 {
            observe(&mut cost, 60, false, now);
        }
        assert!(cost.allows(now));
        assert_eq!(cost.estimate(), Some(Duration::from_millis(60)));
        assert!(cost.begin_trial(now), "live units dispatch normally");
    }

    #[test]
    fn three_consecutive_no_benefit_observations_defer() {
        let now = Instant::now();
        let mut cost = LiveCost::default();
        for _ in 0..2 {
            observe(&mut cost, 1500, false, now);
            assert!(cost.allows(now));
        }
        observe(&mut cost, 1500, false, now);
        assert!(!cost.allows(now));
        assert_eq!(cost.estimate(), Some(Duration::from_millis(1500)));
    }

    #[test]
    fn equal_cost_has_no_benefit() {
        let now = Instant::now();
        let mut cost = LiveCost::default();
        for _ in 0..3 {
            observe(&mut cost, 1300, false, now);
        }
        assert!(!cost.allows(now));
    }

    #[test]
    fn target_is_soft_but_blocking_others_counts_after_three_observations() {
        let now = Instant::now();
        let mut cost = LiveCost::default();
        for _ in 0..4 {
            observe(&mut cost, 50, true, now);
        }
        assert!(
            cost.allows(now),
            "50ms itself is allowed even under contention"
        );
        for _ in 0..2 {
            observe(&mut cost, 51, true, now);
            assert!(cost.allows(now));
        }
        observe(&mut cost, 51, true, now);
        assert!(!cost.allows(now));
    }

    #[test]
    fn beneficial_observation_breaks_the_strike_sequence() {
        let now = Instant::now();
        let mut cost = LiveCost::default();
        for _ in 0..2 {
            observe(&mut cost, 1500, false, now);
        }
        observe(&mut cost, 60, false, now);
        for _ in 0..2 {
            observe(&mut cost, 1500, false, now);
        }
        assert!(cost.allows(now));
        observe(&mut cost, 1500, false, now);
        assert!(!cost.allows(now));
    }

    #[test]
    fn unknown_full_cost_does_not_prove_no_benefit() {
        let now = Instant::now();
        let mut cost = LiveCost::default();
        for _ in 0..6 {
            cost.record(Duration::from_secs(2), TARGET, None, false, now);
        }
        assert!(cost.allows(now));
        for _ in 0..3 {
            cost.record(Duration::from_secs(2), TARGET, None, true, now);
        }
        assert!(
            !cost.allows(now),
            "blocking others needs no full-pass estimate"
        );
    }

    #[test]
    fn cooldown_grants_exactly_one_trial_without_automatically_restoring_live() {
        let now = Instant::now();
        let mut cost = deferred(now);
        assert!(!cost.begin_trial(now + Duration::from_millis(999)));
        assert!(!cost.allows(now + Duration::from_millis(999)));
        assert!(cost.allows(now + Duration::from_secs(1)));
        assert!(cost.allows(now + Duration::from_secs(60)));
        assert!(cost.begin_trial(now + Duration::from_secs(1)));
        assert!(!cost.begin_trial(now + Duration::from_secs(1)));
        assert!(!cost.begin_trial(now + Duration::from_secs(60)));
        assert!(!cost.allows(now + Duration::from_secs(60)));
    }

    #[test]
    fn non_trial_observations_cannot_clear_or_postpone_deferral() {
        let now = Instant::now();
        let mut cost = deferred(now);
        observe(&mut cost, 10, false, now + Duration::from_millis(900));
        assert!(cost.allows(now + Duration::from_secs(1)));
        assert_eq!(cost.estimate(), Some(Duration::from_millis(1500)));
        assert!(cost.begin_trial(now + Duration::from_secs(1)));
    }

    #[test]
    fn successful_trial_restores_live_without_waiting_for_old_median() {
        let now = Instant::now();
        let mut cost = deferred(now);
        let trial = now + Duration::from_secs(1);
        assert!(cost.begin_trial(trial));
        observe(&mut cost, 60, false, trial);
        assert!(cost.allows(trial));
        for _ in 0..2 {
            observe(&mut cost, 1500, false, trial);
        }
        assert!(cost.allows(trial), "recovery resets the strike sequence");
        observe(&mut cost, 1500, false, trial);
        assert!(!cost.allows(trial));
    }

    #[test]
    fn failed_trial_restarts_cooldown_without_a_second_free_trial() {
        let now = Instant::now();
        let mut cost = deferred(now);
        let trial = now + Duration::from_secs(1);
        assert!(cost.begin_trial(trial));
        observe(&mut cost, 1500, false, trial);
        assert!(!cost.allows(trial));
        assert!(!cost.begin_trial(trial + Duration::from_millis(999)));
        assert!(cost.begin_trial(trial + Duration::from_secs(1)));
        assert!(!cost.begin_trial(trial + Duration::from_secs(1)));
    }

    #[test]
    fn caller_can_deliberately_reset_or_delete_without_an_old_strike() {
        let now = Instant::now();
        let mut costs = std::collections::HashMap::from([(1, deferred(now))]);
        costs.insert(1, LiveCost::default()); // deliberate reset
        assert!(costs[&1].allows(now));
        assert_eq!(costs[&1].estimate(), None);
        observe(costs.get_mut(&1).unwrap(), 1500, false, now);
        assert!(costs[&1].allows(now));
        costs.remove(&1); // deleted content
        assert!(costs.entry(1).or_default().allows(now));
    }

    #[test]
    fn cancelled_trial_rearms_cooldown_without_polluting_measurements() {
        let now = Instant::now();
        let mut cost = deferred(now);
        let trial = now + Duration::from_secs(1);
        assert!(cost.begin_trial(trial));
        let finished = trial + Duration::from_millis(200);
        cost.cancel_trial(finished);
        assert_eq!(cost.estimate(), Some(Duration::from_millis(1500)));
        assert!(!cost.allows(finished + Duration::from_millis(999)));
        assert!(cost.begin_trial(finished + Duration::from_secs(1)));
        assert!(!cost.begin_trial(finished + Duration::from_secs(1)));
    }

    #[test]
    fn pruning_preserves_even_one_sample_and_cancelling_live_work_is_a_noop() {
        let now = Instant::now();
        let mut cost = LiveCost::default();
        assert!(cost.is_empty());
        cost.cancel_trial(now);
        assert!(cost.is_empty());
        assert!(cost.allows(now));
        observe(&mut cost, 60, false, now);
        assert!(
            !cost.is_empty(),
            "retain a partial measurement window across layouts"
        );
        cost.cancel_trial(now);
        assert!(cost.allows(now));
        let mut cost = deferred(now);
        assert!(!cost.is_empty());
        assert!(cost.begin_trial(now + Duration::from_secs(1)));
        assert!(!cost.is_empty());
        cost.cancel_trial(now + Duration::from_secs(1));
        assert!(!cost.is_empty());
    }
}
