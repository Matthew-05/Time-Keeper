"""The Summary dashboard's aggregation.

The tests that matter most here are about *where* rounding happens. A day is
the sum of its clients' rounded figures, and a range is the sum of its days —
never a fresh rounding of a combined total. Get that wrong and the Summary page
quietly disagrees with History, Budgets and the invoice, which is the one thing
this module exists to prevent.

The rest guard the empty and boundary cases the dashboard actually meets: a
range with nothing in it, a day worked outside the schedule, a range that runs
into the future, and a weekday filter that selects nothing.

`TotalsTests` goes through `summary.elapsed` first, because the overview
endpoint does and the two together are the unit the page actually sees.
Everything there takes an explicit `today` for that reason: with the cut in
place almost every figure moves as the range fills in, and a test that let
`date.today()` decide would pass or fail depending on the day it was run.
"""

import unittest
from datetime import date

import summary

QUARTER_HOUR = {'enabled': True, 'interval_minutes': 15, 'direction': 'nearest'}
NO_ROUNDING = {'enabled': False, 'interval_minutes': 15, 'direction': 'nearest'}

MONDAY = date(2026, 8, 10)
TUESDAY = date(2026, 8, 11)
SATURDAY = date(2026, 8, 15)
SUNDAY = date(2026, 8, 16)


def weekday_capacity(hours=8.0, work_days=(0, 1, 2, 3, 4)):
    """A plain Monday–Friday schedule, as `day_rows` wants it."""
    def capacity_for(day):
        return day.weekday() in work_days, hours
    return capacity_for


def build(seconds_by_client_day, start=MONDAY, end=SUNDAY, policy=QUARTER_HOUR, **kwargs):
    return summary.day_rows(
        start, end, seconds_by_client_day, weekday_capacity(), policy=policy, **kwargs
    )


class DayRowTests(unittest.TestCase):
    def test_every_date_in_the_window_gets_a_row(self):
        rows = build({})
        self.assertEqual(len(rows), 7)
        self.assertEqual(rows[0]['date'], '2026-08-10')
        self.assertEqual(rows[-1]['date'], '2026-08-16')
        self.assertTrue(all(row['billable_hours'] == 0 for row in rows))
        self.assertTrue(all(row['clients'] == [] for row in rows))

    def test_rounding_is_per_client_per_day(self):
        # Two clients, seven minutes each on one day. Rounded separately they
        # both fall to zero; rounded together the 14 minutes would climb to a
        # quarter of an hour that nobody may bill.
        rows = build({('Acme', MONDAY): 7 * 60, ('Globex', MONDAY): 7 * 60})
        self.assertEqual(rows[0]['billable_hours'], 0.0)
        self.assertEqual([c['billable_hours'] for c in rows[0]['clients']], [0.0, 0.0])
        self.assertAlmostEqual(rows[0]['tracked_hours'], 0.23, places=2)

    def test_a_day_is_the_sum_of_its_clients_rounded_figures(self):
        # 8 minutes each rounds up to 0.25 twice — 0.5 for the day, where one
        # combined rounding of 16 minutes would have given 0.25.
        rows = build({('Acme', MONDAY): 8 * 60, ('Globex', MONDAY): 8 * 60})
        self.assertEqual(rows[0]['billable_hours'], 0.5)

    def test_a_client_across_two_days_rounds_on_each(self):
        rows = build({('Acme', MONDAY): 8 * 60, ('Acme', TUESDAY): 8 * 60})
        self.assertEqual([rows[0]['billable_hours'], rows[1]['billable_hours']], [0.25, 0.25])
        self.assertEqual(summary.client_rollup(rows)[0]['billable_hours'], 0.5)

    def test_clients_are_ordered_by_billable_hours_then_name(self):
        rows = build({
            ('Zeta', MONDAY): 3600,
            ('Alpha', MONDAY): 3600,
            ('Beta', MONDAY): 2 * 3600,
        })
        self.assertEqual(
            [c['client_name'] for c in rows[0]['clients']],
            ['Beta', 'Alpha', 'Zeta'],
        )

    def test_a_non_working_day_contributes_no_capacity(self):
        rows = build({('Acme', SATURDAY): 3 * 3600})
        saturday = next(row for row in rows if row['date'] == '2026-08-15')
        self.assertFalse(saturday['is_workday'])
        self.assertEqual(saturday['capacity_hours'], 0.0)
        # The time is still billable — the schedule says nothing about what
        # was worked, only about what was planned for.
        self.assertEqual(saturday['billable_hours'], 3.0)

    def test_disabled_rounding_reports_tracked_time(self):
        rows = build({('Acme', MONDAY): 50 * 60}, policy=NO_ROUNDING)
        self.assertAlmostEqual(rows[0]['billable_hours'], 0.83, places=2)
        self.assertEqual(rows[0]['billable_hours'], rows[0]['tracked_hours'])

    def test_amounts_are_present_and_null_until_rates_exist(self):
        rows = build({('Acme', MONDAY): 3600})
        self.assertIsNone(rows[0]['billable_amount'])
        self.assertIsNone(rows[0]['clients'][0]['billable_amount'])

    def test_hours_and_seconds_always_agree(self):
        rows = build({('Acme', MONDAY): 7 * 60, ('Globex', MONDAY): 8 * 60})
        for entry in [rows[0], *rows[0]['clients']]:
            with self.subTest(entry=entry.get('client_name', entry.get('date'))):
                self.assertEqual(entry['billable_hours'],
                                 round(entry['billable_seconds'] / 3600, 2))
                self.assertEqual(entry['tracked_hours'],
                                 round(entry['tracked_seconds'] / 3600, 2))

    def test_totals_are_summed_from_seconds_not_from_printed_hours(self):
        # A seven-minute interval makes every figure a repeating decimal, so
        # summing the two-decimal display values drifts. Ten days of it is a
        # tenth of an hour adrift, which is enough to see on screen.
        policy = {'enabled': True, 'interval_minutes': 7, 'direction': 'up'}
        rows = summary.day_rows(
            date(2026, 8, 1), date(2026, 8, 10),
            {('Acme', date(2026, 8, day)): 60 for day in range(1, 11)},
            weekday_capacity(), policy=policy,
        )
        client = summary.client_rollup(rows)[0]
        # Ten days of one 7-minute unit each: exactly 70 minutes.
        self.assertEqual(client['billable_seconds'], 70 * 60)
        self.assertEqual(client['billable_hours'], 1.17)
        # Summing the printed 0.12 ten times would have given 1.2.
        self.assertEqual(
            summary.totals(rows, [client])['billable_hours'], 1.17
        )


class WeekdayFilterTests(unittest.TestCase):
    def test_only_matching_days_are_kept(self):
        rows = build({('Acme', MONDAY): 3600, ('Acme', TUESDAY): 3600}, weekdays={0})
        self.assertEqual([row['date'] for row in rows], ['2026-08-10'])

    def test_a_filter_that_matches_nothing_yields_no_rows(self):
        rows = build({('Acme', MONDAY): 3600}, start=MONDAY, end=TUESDAY, weekdays={5})
        self.assertEqual(rows, [])
        self.assertEqual(summary.client_rollup(rows), [])
        self.assertEqual(summary.totals(rows, [])['billable_hours'], 0)

    def test_none_means_every_day(self):
        self.assertEqual(len(build({}, weekdays=None)), 7)


class ClientRollupTests(unittest.TestCase):
    def setUp(self):
        self.rows = build({
            ('Acme', MONDAY): 3 * 3600,
            ('Globex', MONDAY): 4 * 3600,
            ('Acme', TUESDAY): 3600,
        })
        self.clients = summary.client_rollup(self.rows)

    def test_totals_and_ordering(self):
        self.assertEqual(
            [(c['client_name'], c['billable_hours']) for c in self.clients],
            [('Acme', 4.0), ('Globex', 4.0)],
        )
        # Equal figures fall back to the name, so the order is stable.
        self.assertEqual(self.clients[0]['client_name'], 'Acme')

    def test_days_worked_counts_days_not_entries(self):
        self.assertEqual(self.clients[0]['days_worked'], 2)
        self.assertEqual(self.clients[1]['days_worked'], 1)

    def test_stored_color_is_preserved_in_the_rollup(self):
        for row in self.rows:
            for client in row['clients']:
                if client['client_name'] == 'Acme':
                    client['client_color'] = '#123456'
        clients = summary.client_rollup(self.rows)
        self.assertEqual(clients[0]['client_color'], '#123456')

    def test_average_is_per_day_the_client_was_worked(self):
        self.assertEqual(self.clients[0]['avg_billable_per_day'], 2.0)

    def test_shares_sum_to_one_hundred(self):
        self.assertEqual(sum(c['share_percent'] for c in self.clients), 100.0)

    def test_share_is_none_when_nothing_is_billable(self):
        rows = build({('Acme', MONDAY): 60})  # One minute, rounds away.
        client = summary.client_rollup(rows)[0]
        self.assertEqual(client['billable_hours'], 0.0)
        self.assertIsNone(client['share_percent'])


class ElapsedTests(unittest.TestCase):
    """The cut every figure on the dashboard is taken after."""

    def test_today_is_kept_and_tomorrow_is_not(self):
        rows = build({})
        kept = summary.elapsed(rows, today=TUESDAY)
        self.assertEqual([row['date'] for row in kept], ['2026-08-10', '2026-08-11'])

    def test_a_range_entirely_ahead_leaves_nothing(self):
        self.assertEqual(summary.elapsed(build({}), today=date(2026, 8, 1)), [])

    def test_a_range_entirely_past_is_untouched(self):
        rows = build({})
        self.assertEqual(summary.elapsed(rows, today=date(2027, 1, 1)), rows)

    def test_the_rows_themselves_are_not_copied(self):
        # The overview hands the same list to the rollup, the totals and the
        # payload; they must all be looking at one set of objects.
        rows = build({('Acme', MONDAY): 3600})
        self.assertIs(summary.elapsed(rows, today=SUNDAY)[0], rows[0])


class TotalsTests(unittest.TestCase):
    def setUp(self):
        self.rows = build({
            ('Acme', MONDAY): 3 * 3600,
            ('Globex', MONDAY): 4 * 3600,
            ('Acme', TUESDAY): 45 * 60,
        })

    def totals(self, rows=None, today=SUNDAY):
        """What `/api/summary/overview` computes: cut to elapsed, then roll up.

        `today` defaults to the end of the range, so a test that isn't about
        the cut sees the whole week and reads as it did before there was one.
        """
        rows = self.rows if rows is None else rows
        elapsed = summary.elapsed(rows, today=today)
        return summary.totals(elapsed, summary.client_rollup(elapsed), selected=rows)

    def test_every_figure_stops_at_today(self):
        # Mon–Sun holds five 8-hour workdays, but only two have elapsed by
        # Tuesday. 7.75 billable over 16 elapsed hours is 48.4%, not the 19.4%
        # that measuring against the whole week would give.
        totals = self.totals(today=TUESDAY)
        self.assertEqual(totals['capacity_hours'], 16.0)
        self.assertEqual(totals['workdays'], 2)
        self.assertEqual(totals['days_in_range'], 2)
        self.assertEqual(totals['utilisation_percent'], 48.4)

    def test_the_selection_is_reported_beside_the_elapsed_part(self):
        # Context for the "2 of 7 days" label, and the only place the days
        # ahead are counted at all.
        totals = self.totals(today=TUESDAY)
        self.assertEqual(totals['days_selected'], 7)
        self.assertEqual(totals['workdays_selected'], 5)
        # Nothing ahead: the two pairs agree, and the label says "7 days".
        whole = self.totals()
        self.assertEqual(whole['days_selected'], whole['days_in_range'])
        self.assertEqual(whole['workdays_selected'], whole['workdays'])

    def test_selected_defaults_to_the_rows_given(self):
        totals = summary.totals(self.rows, [])
        self.assertEqual(totals['days_selected'], 7)

    def test_today_counts_as_fully_elapsed(self):
        # Time recorded this morning is already in the numerator, so today's
        # capacity has to be in the denominator too.
        self.assertEqual(self.totals(today=MONDAY)['capacity_hours'], 8.0)

    def test_a_range_entirely_in_the_future_is_empty_rather_than_zero(self):
        totals = self.totals(today=date(2026, 8, 1))
        self.assertEqual(totals['capacity_hours'], 0.0)
        self.assertEqual(totals['days_in_range'], 0)
        self.assertEqual(totals['days_selected'], 7)
        self.assertIsNone(totals['utilisation_percent'])
        self.assertIsNone(totals['avg_vs_capacity_percent'])
        # The days are ahead, not unworked — nothing may be attributed to them.
        self.assertEqual(totals['billable_hours'], 0.0)
        self.assertEqual(totals['days_worked'], 0)

    def test_days_worked_counts_days_with_tracked_time(self):
        totals = self.totals()
        self.assertEqual(totals['days_worked'], 2)
        self.assertEqual(totals['days_in_range'], 7)
        self.assertEqual(totals['workdays'], 5)

    def test_a_day_that_rounds_away_still_counts_as_worked(self):
        totals = self.totals(build({('Acme', MONDAY): 60}))
        self.assertEqual(totals['billable_hours'], 0)
        self.assertEqual(totals['days_worked'], 1)
        self.assertEqual(totals['avg_billable_per_worked_day'], 0.0)

    def test_rounding_delta_is_signed(self):
        # 45 minutes is exact; 3h and 4h are exact. Nothing moves.
        self.assertEqual(self.totals()['rounding_delta_hours'], 0.0)
        # 50 minutes rounds down to 45, giving away five minutes.
        self.assertLess(
            self.totals(build({('Acme', MONDAY): 50 * 60}))['rounding_delta_hours'], 0
        )
        # 8 minutes rounds up to 15, billing seven that weren't tracked.
        self.assertGreater(
            self.totals(build({('Acme', MONDAY): 8 * 60}))['rounding_delta_hours'], 0
        )

    def test_active_days_are_workdays_plus_any_other_day_billed(self):
        # Mon–Sun: five workdays, and the weekend contributes nothing.
        self.assertEqual(self.totals()['active_days'], 5)
        self.assertEqual(self.totals()['avg_billable_per_active_day'], 1.55)

    def test_a_billed_weekend_joins_the_average(self):
        totals = self.totals(build({
            ('Acme', MONDAY): 8 * 3600, ('Acme', SATURDAY): 4 * 3600,
        }))
        # Five workdays plus the Saturday, not the whole seven-day week.
        self.assertEqual(totals['active_days'], 6)
        self.assertEqual(totals['avg_billable_per_active_day'], 2.0)

    def test_an_empty_weekend_never_joins_the_average(self):
        totals = self.totals(build({('Acme', MONDAY): 5 * 3600}))
        self.assertEqual(totals['active_days'], 5)
        self.assertEqual(totals['avg_billable_per_active_day'], 1.0)

    def test_a_non_working_day_that_rounds_away_is_not_active(self):
        # One tracked minute on a Saturday rounds to nothing billable, so the
        # day contributes no numerator and must not widen the denominator.
        self.assertEqual(self.totals(build({('Acme', SATURDAY): 60}))['active_days'], 5)

    def test_a_range_of_only_empty_non_working_days_has_no_average(self):
        totals = self.totals(build({}, start=SATURDAY, end=SUNDAY))
        self.assertEqual(totals['active_days'], 0)
        self.assertEqual(totals['avg_billable_per_active_day'], 0.0)

    def test_the_average_moves_as_the_range_elapses(self):
        # It used to describe the whole range and stay put. It now describes
        # what has happened, which is the point: 7.75 hours over the two days
        # that exist so far, not spread across five that mostly don't.
        self.assertEqual(self.totals(today=TUESDAY)['avg_billable_per_active_day'], 3.88)
        self.assertEqual(self.totals(today=SUNDAY)['avg_billable_per_active_day'], 1.55)

    def test_busiest_day_is_the_largest_billable_day(self):
        self.assertEqual(self.totals()['busiest_day'],
                         {'date': '2026-08-10', 'billable_hours': 7.0})

    def test_an_empty_range_has_no_busiest_day_and_no_top_share(self):
        totals = self.totals(build({}))
        self.assertIsNone(totals['busiest_day'])
        self.assertIsNone(totals['top_client_share_percent'])
        self.assertEqual(totals['client_count'], 0)
        self.assertEqual(totals['avg_billable_per_worked_day'], 0.0)

    def test_amount_and_currency_fields_ship_null(self):
        self.assertIsNone(self.totals()['billable_amount'])


class AverageAgainstCapacityTests(unittest.TestCase):
    """The average billed day as a share of the average scheduled day."""

    def totals(self, rows, today=SUNDAY):
        elapsed = summary.elapsed(rows, today=today)
        return summary.totals(elapsed, summary.client_rollup(elapsed), selected=rows)

    def test_capacity_per_workday_is_a_mean_of_the_elapsed_workdays(self):
        totals = self.totals(build({}), today=TUESDAY)
        self.assertEqual(totals['capacity_hours'], 16.0)
        self.assertEqual(totals['avg_capacity_per_workday'], 8.0)

    def test_a_full_schedule_reads_as_one_hundred_percent(self):
        rows = build({('Acme', day): 8 * 3600 for day in (
            MONDAY, TUESDAY, date(2026, 8, 12), date(2026, 8, 13), date(2026, 8, 14),
        )})
        self.assertEqual(self.totals(rows)['avg_vs_capacity_percent'], 100.0)

    def test_weekend_work_pulls_it_down_where_it_pushes_utilisation_up(self):
        # 12 hours over six active days is 2.0 a day, against an 8-hour
        # scheduled day: 25%. Utilisation sees the same 12 hours against the
        # week's 40 and reads 30%. The gap is the Saturday, which adds a day to
        # the average without adding any capacity to divide by.
        totals = self.totals(build({
            ('Acme', MONDAY): 8 * 3600, ('Acme', SATURDAY): 4 * 3600,
        }))
        self.assertEqual(totals['avg_vs_capacity_percent'], 25.0)
        self.assertEqual(totals['utilisation_percent'], 30.0)

    def test_the_two_agree_when_nothing_was_worked_off_schedule(self):
        totals = self.totals(build({('Acme', MONDAY): 10 * 3600}))
        self.assertEqual(totals['avg_vs_capacity_percent'], totals['utilisation_percent'])

    def test_no_workdays_means_no_ratio_rather_than_zero(self):
        totals = self.totals(build({('Acme', SATURDAY): 3600}, start=SATURDAY, end=SUNDAY))
        self.assertEqual(totals['avg_capacity_per_workday'], 0.0)
        self.assertIsNone(totals['avg_vs_capacity_percent'])


class NonWorkingDayTests(unittest.TestCase):
    """Time billed on days the schedule never asked for."""

    def totals(self, rows, today=SUNDAY):
        elapsed = summary.elapsed(rows, today=today)
        return summary.totals(elapsed, summary.client_rollup(elapsed), selected=rows)

    def test_only_non_working_days_are_counted(self):
        off = self.totals(build({
            ('Acme', MONDAY): 8 * 3600,
            ('Acme', SATURDAY): 4 * 3600,
            ('Globex', SUNDAY): 90 * 60,
        }))['non_working']
        self.assertEqual(off['billable_hours'], 5.5)
        self.assertEqual(off['days'], 2)
        self.assertEqual(off['days_worked'], 2)

    def test_an_untouched_weekend_reports_zero_across_its_days(self):
        off = self.totals(build({('Acme', MONDAY): 8 * 3600}))['non_working']
        self.assertEqual(off['billable_hours'], 0.0)
        self.assertEqual(off['days'], 2)
        self.assertEqual(off['days_worked'], 0)

    def test_a_day_that_rounds_away_was_still_worked(self):
        off = self.totals(build({('Acme', SATURDAY): 60}))['non_working']
        self.assertEqual(off['billable_hours'], 0.0)
        self.assertAlmostEqual(off['tracked_hours'], 0.02, places=2)
        self.assertEqual(off['days_worked'], 1)

    def test_a_weekend_still_ahead_is_not_counted(self):
        off = self.totals(build({('Acme', MONDAY): 8 * 3600}), today=TUESDAY)['non_working']
        self.assertEqual(off['days'], 0)

    def test_the_amount_ships_null_like_every_other_figure(self):
        self.assertIsNone(self.totals(build({}))['non_working']['billable_amount'])


class ParseWindowTests(unittest.TestCase):
    def test_accepts_an_ordered_iso_range(self):
        start, end, error = summary.parse_window('2026-08-10', '2026-08-16', 370)
        self.assertIsNone(error)
        self.assertEqual((start, end), (MONDAY, SUNDAY))

    def test_a_single_day_is_a_valid_window(self):
        start, end, error = summary.parse_window('2026-08-10', '2026-08-10', 370)
        self.assertIsNone(error)
        self.assertEqual(start, end)

    def test_a_backwards_range_is_rejected_rather_than_swapped(self):
        _, _, error = summary.parse_window('2026-08-16', '2026-08-10', 370)
        self.assertIn('must follow', error)

    def test_bad_and_missing_dates_are_rejected(self):
        for start, end in [('nope', '2026-08-16'), (None, None), ('', ''),
                           ('2026-13-01', '2026-08-16'), ('08/10/2026', '2026-08-16')]:
            with self.subTest(start=start, end=end):
                _, _, error = summary.parse_window(start, end, 370)
                self.assertEqual(error, 'Expected ISO start and end dates.')

    def test_the_window_is_bounded(self):
        _, _, error = summary.parse_window('2020-01-01', '2026-08-10', 370)
        self.assertIn('370 days', error)
        # Exactly at the limit is fine.
        _, _, error = summary.parse_window('2026-01-01', '2027-01-06', 370)
        self.assertIsNone(error)


class ParseWeekdaysTests(unittest.TestCase):
    def test_blank_means_every_day(self):
        for raw in (None, '', '   '):
            with self.subTest(raw=raw):
                self.assertEqual(summary.parse_weekdays(raw), (None, None))

    def test_parses_a_comma_separated_list(self):
        days, error = summary.parse_weekdays('0,3')
        self.assertIsNone(error)
        self.assertEqual(days, {0, 3})

    def test_tolerates_trailing_separators(self):
        self.assertEqual(summary.parse_weekdays('0,')[0], {0})

    def test_rejects_out_of_range_numbers(self):
        for raw in ('7', '-1', '0,9'):
            with self.subTest(raw=raw):
                days, error = summary.parse_weekdays(raw)
                self.assertIsNone(days)
                self.assertIn('0 (Monday) to 6 (Sunday)', error)

    def test_rejects_non_numeric_values(self):
        days, error = summary.parse_weekdays('monday')
        self.assertIsNone(days)
        self.assertIn('comma-separated numbers', error)


if __name__ == '__main__':
    unittest.main()
