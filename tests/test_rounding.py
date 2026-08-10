import unittest
from datetime import date, time
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import budgets
import settings
from rounding import round_seconds_to_hours


class RoundingPolicyTests(unittest.TestCase):
    def test_nearest_uses_half_up(self):
        policy = {'interval_minutes': 15, 'direction': 'nearest'}
        self.assertEqual(round_seconds_to_hours(7.5 * 60, policy), 0.25)
        self.assertEqual(round_seconds_to_hours(7 * 60, policy), 0.0)

    def test_up_and_down_use_the_selected_interval(self):
        up = {'interval_minutes': 10, 'direction': 'up'}
        down = {'interval_minutes': 10, 'direction': 'down'}
        self.assertEqual(round_seconds_to_hours(11 * 60, up), 20 / 60)
        self.assertEqual(round_seconds_to_hours(19 * 60, down), 10 / 60)

    def test_disabled_policy_returns_tracked_time(self):
        policy = {
            'enabled': False,
            'interval_minutes': 15,
            'direction': 'up',
        }
        self.assertEqual(round_seconds_to_hours(8 * 60, policy), 8 / 60)

    def test_custom_whole_minute_interval(self):
        policy = {'interval_minutes': 6, 'direction': 'nearest'}
        self.assertEqual(round_seconds_to_hours(8 * 60, policy), 6 / 60)


class SettingsTests(unittest.TestCase):
    def test_rounding_defaults_preserve_existing_behavior(self):
        clean = settings._coerce({})
        self.assertTrue(clean['rounding_enabled'])
        self.assertEqual(clean['rounding_interval_minutes'], 15)
        self.assertEqual(clean['rounding_direction'], 'nearest')

    def test_rounding_settings_validate_custom_policy(self):
        clean = settings._coerce({
            'rounding_enabled': False,
            'rounding_interval_minutes': 7,
            'rounding_direction': 'down',
        })
        self.assertFalse(clean['rounding_enabled'])
        self.assertEqual(clean['rounding_interval_minutes'], 7)
        self.assertEqual(clean['rounding_direction'], 'down')

    def test_preview_settings_does_not_write_and_matches_schedule_semantics(self):
        with TemporaryDirectory() as directory:
            settings_path = Path(directory) / 'settings.json'
            with patch.object(settings, 'SETTINGS_PATH', str(settings_path)):
                preview = settings.preview_settings(
                    {'work_hours_per_day': 6, 'work_days': [0, 2, 4]},
                    effective_date=date(2026, 8, 10),
                )

            self.assertFalse(settings_path.exists())
            self.assertEqual(preview['work_hours_per_day'], 6)
            self.assertEqual(preview['work_days'], [0, 2, 4])
            self.assertEqual(
                preview['work_schedule_history'],
                [
                    {
                        'effective_from': date.min.isoformat(),
                        'hours_per_day': 8,
                        'work_days': [0, 1, 2, 3, 4],
                    },
                    {
                        'effective_from': '2026-08-10',
                        'hours_per_day': 6,
                        'work_days': [0, 2, 4],
                    },
                ],
            )


class BudgetRoundingTests(unittest.TestCase):
    @staticmethod
    def task(task_id, day, start_minute, end_minute):
        return SimpleNamespace(
            id=task_id,
            date=day,
            start_time=time(9, start_minute),
            end_time=time(9, end_minute),
        )

    def test_rounding_is_applied_once_per_client_day(self):
        day = date(2026, 8, 10)
        tasks = [self.task(1, day, 0, 10), self.task(2, day, 10, 20)]
        policy = {'interval_minutes': 15, 'direction': 'nearest'}

        allocated = budgets.billable_hours_by_task(tasks, rounding_policy=policy)

        self.assertAlmostEqual(sum(allocated.values()), 0.25)
        self.assertAlmostEqual(allocated[1], allocated[2])

    def test_disabled_rounding_keeps_raw_budget_hours(self):
        day = date(2026, 8, 10)
        tasks = [self.task(1, day, 0, 10), self.task(2, day, 10, 20)]

        allocated = budgets.billable_hours_by_task(
            tasks, rounding_policy={'enabled': False}
        )

        self.assertAlmostEqual(sum(allocated.values()), 20 / 60)


if __name__ == '__main__':
    unittest.main()
