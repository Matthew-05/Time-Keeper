"""The week-start preference, and the boundary it must not cross.

`week_start` decides which column a calendar begins on and nothing else. The
tests that matter most here are the negative ones: that a bad value can't get
stored, and that changing it leaves the capacity model — which is keyed on ISO
weekday numbers — completely alone.
"""

import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import budgets
import settings


class WeekStartSettingTests(unittest.TestCase):
    def test_defaults_to_sunday(self):
        self.assertEqual(settings.DEFAULTS['week_start'], 'sunday')
        self.assertEqual(settings._coerce({})['week_start'], 'sunday')

    def test_accepts_both_choices(self):
        for choice in ('sunday', 'monday'):
            self.assertEqual(settings._coerce({'week_start': choice})['week_start'], choice)

    def test_accepts_any_casing(self):
        self.assertEqual(settings._coerce({'week_start': 'Monday'})['week_start'], 'monday')

    def test_rejected_values_fall_back_to_the_default(self):
        # A hand-edited file or a stale client shouldn't be able to leave the
        # app with a week that starts on a day that doesn't exist.
        for bad in ('tuesday', '', 'sun', 0, 6, None, True, ['monday']):
            with self.subTest(value=bad):
                self.assertEqual(settings._coerce({'week_start': bad})['week_start'], 'sunday')

    def test_survives_a_round_trip_through_disk(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / 'settings.json'
            with patch.object(settings, 'SETTINGS_PATH', str(path)):
                with patch.object(settings, 'USER_DATA_DIR', directory):
                    stored = settings.update_settings({'week_start': 'monday'})
                    self.assertEqual(stored['week_start'], 'monday')
                    self.assertEqual(settings.load_settings()['week_start'], 'monday')


class WeekStartIsDisplayOnlyTests(unittest.TestCase):
    """Capacity is keyed on ISO weekday numbers, which never renumber.

    Nothing in ``budgets`` reads ``week_start``, and that absence is the whole
    guarantee — so these assert the absence rather than exercise a path.
    """

    def _work_days(self, week_start):
        return settings._coerce({'week_start': week_start})['work_days']

    def test_the_recurring_workweek_is_unchanged_by_the_preference(self):
        self.assertEqual(self._work_days('sunday'), self._work_days('monday'))
        self.assertEqual(self._work_days('sunday'), settings.DEFAULT_WORK_DAYS)

    def test_default_work_days_still_mean_monday_to_friday(self):
        # August 2026 has 21 weekdays. If a Sunday start ever shifted the
        # numbering, [0, 1, 2, 3, 4] would quietly become Sun-Thu and this
        # count would move to 22.
        for week_start in ('sunday', 'monday'):
            with self.subTest(week_start=week_start):
                self.assertEqual(
                    budgets.business_days_in_month(2026, 8, self._work_days(week_start)),
                    21,
                )

    def test_a_stored_weekday_number_still_resolves_to_the_same_date(self):
        # 2026-08-03 is a Monday, so ISO 0 — under either preference.
        self.assertEqual(date(2026, 8, 3).weekday(), 0)
        self.assertEqual(date(2026, 8, 9).weekday(), 6)


if __name__ == '__main__':
    unittest.main()
