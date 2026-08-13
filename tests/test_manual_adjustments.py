import unittest
from datetime import date, datetime, time
from types import SimpleNamespace

import budgets
from manual_adjustments import adjustment_figures


NEAREST_15 = {
    'enabled': True,
    'interval_minutes': 15,
    'direction': 'nearest',
}


class ManualAdjustmentArithmeticTests(unittest.TestCase):
    def test_missing_adjustment_preserves_raw_actual_and_ordinary_rounding(self):
        figures = adjustment_figures(47 * 60, None, NEAREST_15)

        self.assertEqual(figures['adjusted_seconds'], 47 * 60)
        self.assertEqual(figures['billable_seconds'], 45 * 60)
        self.assertFalse(figures['has_adjustment'])

    def test_adjustment_starts_from_raw_total_then_becomes_rounding_input(self):
        figures = adjustment_figures(47 * 60, 10, NEAREST_15)

        self.assertEqual(figures['base_seconds'], 47 * 60)
        self.assertEqual(figures['adjusted_seconds'], 57 * 60)
        self.assertEqual(figures['billable_seconds'], 60 * 60)

    def test_rounding_disabled_uses_adjusted_actual_directly(self):
        figures = adjustment_figures(
            47 * 60,
            -7,
            {'enabled': False, 'interval_minutes': 15, 'direction': 'up'},
        )

        self.assertEqual(figures['base_seconds'], 47 * 60)
        self.assertEqual(figures['adjusted_seconds'], 40 * 60)
        self.assertEqual(figures['billable_seconds'], 40 * 60)

    def test_adjusted_total_cannot_be_negative(self):
        with self.assertRaisesRegex(ValueError, 'cannot be negative'):
            adjustment_figures(5 * 60, -16, NEAREST_15)


class ManualAdjustmentBudgetTests(unittest.TestCase):
    DAY = date(2026, 8, 13)

    @classmethod
    def task(cls, minutes):
        return SimpleNamespace(
            id=1,
            date=cls.DAY,
            start_time=time(9, 0),
            end_time=time(9, minutes),
            budget_id=None,
            budget_excluded=False,
        )

    @classmethod
    def budget(cls):
        return SimpleNamespace(
            id=1,
            start_date=cls.DAY,
            end_date=cls.DAY,
            budgeted_hours=10,
            closed_at=None,
        )

    def test_adjusted_client_day_replaces_budget_rounding_input(self):
        used, split, unbudgeted, ledger = budgets.allocation_ledger(
            [self.budget()],
            [self.task(47)],
            rounding_policy=NEAREST_15,
            manual_adjustments={self.DAY: 10},
        )

        self.assertEqual(round(used[1] * 60), 60)
        self.assertEqual(unbudgeted, 0)
        self.assertEqual(round(ledger[0]['tracked_hours'] * 60), 47)
        self.assertEqual(round(ledger[0]['raw_hours'] * 60), 57)
        self.assertEqual(round(ledger[0]['rounded_hours'] * 60), 60)
        self.assertEqual(ledger[0]['manual_adjustment_minutes'], 10)
        # A client-level correction does not rewrite an individual task.
        self.assertEqual(round(sum(row[1] for row in split[1]) * 60), 47)

    def test_manual_only_day_flows_into_covering_budget(self):
        used, split, unbudgeted, ledger = budgets.allocation_ledger(
            [self.budget()],
            [],
            rounding_policy=NEAREST_15,
            manual_adjustments={self.DAY: 30},
        )

        self.assertEqual(used[1], 0.5)
        self.assertEqual(split, {})
        self.assertEqual(unbudgeted, 0)
        self.assertEqual(ledger[0]['raw_hours'], 0.5)
        self.assertEqual(ledger[0]['destinations'][0]['task_ids'], [])

    def test_manual_only_uncovered_day_is_unbudgeted(self):
        _used, _split, unbudgeted, ledger = budgets.allocation_ledger(
            [],
            [],
            rounding_policy=NEAREST_15,
            manual_adjustments={self.DAY: 30},
        )

        self.assertEqual(unbudgeted, 0.5)
        self.assertEqual(
            ledger[0]['destinations'][0]['reason'], 'coverage_gap'
        )

    def test_running_adjusted_day_uses_only_fully_elapsed_minutes(self):
        running = self.task(1)
        running.end_time = None

        _used, _split, _unbudgeted, ledger = budgets.allocation_ledger(
            [self.budget()],
            [running],
            now=datetime(2026, 8, 13, 9, 5, 59),
            rounding_policy=NEAREST_15,
            manual_adjustments={self.DAY: 1},
        )

        self.assertEqual(ledger[0]['tracked_hours'] * 60, 5)
        self.assertEqual(ledger[0]['raw_hours'] * 60, 6)
        self.assertEqual(
            sum(row['raw_hours'] for row in ledger[0]['destinations']) * 60,
            6,
        )


if __name__ == '__main__':
    unittest.main()
