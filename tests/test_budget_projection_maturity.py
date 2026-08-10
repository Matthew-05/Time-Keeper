import unittest
from datetime import date
from types import SimpleNamespace

import budgets


class ProjectionMaturityTests(unittest.TestCase):
    def setUp(self):
        self.budget = SimpleNamespace(
            id=1,
            name='Burst-prone client',
            client_id=1,
            client=None,
            start_date=date(2026, 8, 3),
            end_date=date(2026, 8, 28),
            budgeted_hours=30,
            risk_threshold_percent=10,
            notes=None,
            closed_at=None,
        )

    def summary(self, used_hours, today):
        return budgets.summarise(
            self.budget,
            used_hours,
            hours_per_day=160,
            today=today,
        )

    def test_early_burst_does_not_trigger_pace_warning(self):
        summary = self.summary(10, date(2026, 8, 6))

        self.assertEqual(summary['elapsed_business_days'], 4)
        self.assertEqual(summary['percent_elapsed'], 20)
        self.assertEqual(summary['projected_hours'], 50)
        self.assertFalse(summary['projection_mature'])
        self.assertEqual(summary['status'], 'on_track')

    def test_pace_warning_can_trigger_after_both_maturity_gates(self):
        summary = self.summary(10, date(2026, 8, 7))

        self.assertEqual(summary['elapsed_business_days'], 5)
        self.assertEqual(summary['percent_elapsed'], 25)
        self.assertTrue(summary['projection_mature'])
        self.assertEqual(summary['status'], 'at_risk')

    def test_actual_overage_wins_before_projection_matures(self):
        summary = self.summary(31, date(2026, 8, 3))

        self.assertFalse(summary['projection_mature'])
        self.assertEqual(summary['status'], 'over')


if __name__ == '__main__':
    unittest.main()
