"""Finding a day's untracked time, and stretching a day to fit a task.

Two things drive most of these cases. Intervals are **half-open** — the whole
reason back-to-back tasks aren't treated as touching — and the input is
whatever the Task Browser can be edited into, which is not necessarily sorted,
disjoint, or inside the day at all.
"""

import unittest
from datetime import time

import day_bounds


def gaps(start, end, busy, **kwargs):
    return day_bounds.find_gaps(start, end, busy, **kwargs)


class FindGapsTests(unittest.TestCase):
    def test_an_empty_day_is_one_gap(self):
        self.assertEqual(
            gaps(time(9, 0), time(17, 0), []),
            [(time(9, 0), time(17, 0))],
        )

    def test_gaps_fall_before_between_and_after_the_tasks(self):
        self.assertEqual(
            gaps(time(9, 0), time(17, 0), [
                (time(9, 30), time(11, 0)),
                (time(13, 0), time(15, 0)),
            ]),
            [
                (time(9, 0), time(9, 30)),
                (time(11, 0), time(13, 0)),
                (time(15, 0), time(17, 0)),
            ],
        )

    def test_back_to_back_tasks_leave_no_gap_between_them(self):
        # Half-open intervals: 11:00 is the end of one and the start of the
        # next, and that shared instant is not untracked time.
        self.assertEqual(
            gaps(time(9, 0), time(12, 0), [
                (time(9, 0), time(11, 0)),
                (time(11, 0), time(12, 0)),
            ]),
            [],
        )

    def test_a_fully_tracked_day_has_no_gaps(self):
        self.assertEqual(gaps(time(9, 0), time(17, 0), [(time(9, 0), time(17, 0))]), [])

    def test_unsorted_input_is_handled(self):
        self.assertEqual(
            gaps(time(9, 0), time(17, 0), [
                (time(14, 0), time(17, 0)),
                (time(9, 0), time(12, 0)),
            ]),
            [(time(12, 0), time(14, 0))],
        )

    def test_overlapping_tasks_are_merged_rather_than_rejected(self):
        # An editable table can be put into this state; a suggestion engine is
        # not the place to complain about it.
        self.assertEqual(
            gaps(time(9, 0), time(17, 0), [
                (time(9, 0), time(13, 0)),
                (time(11, 0), time(15, 0)),
            ]),
            [(time(15, 0), time(17, 0))],
        )

    def test_a_task_nested_inside_another_moves_nothing(self):
        self.assertEqual(
            gaps(time(9, 0), time(17, 0), [
                (time(9, 0), time(16, 0)),
                (time(10, 0), time(11, 0)),
            ]),
            [(time(16, 0), time(17, 0))],
        )

    def test_tasks_outside_the_window_are_clipped(self):
        self.assertEqual(
            gaps(time(9, 0), time(17, 0), [
                (time(7, 0), time(9, 30)),
                (time(16, 30), time(19, 0)),
            ]),
            [(time(9, 30), time(16, 30))],
        )

    def test_even_a_sliver_is_returned(self):
        # find_gaps is geometry, not judgement. The strip draws every gap, so
        # leaving the short ones out would make the drawing stop adding up to
        # the day; suggest_gap is where the threshold lives.
        self.assertEqual(
            gaps(time(9, 0), time(12, 0), [
                (time(9, 0), time(10, 0)),
                (time(10, 2), time(12, 0)),
            ]),
            [(time(10, 0), time(10, 2))],
        )

    def test_a_window_with_no_end_yields_nothing(self):
        # A day that was never ended and isn't today: there is nothing to
        # measure the untracked time against, so nothing is suggested.
        self.assertEqual(gaps(time(9, 0), None, []), [])
        self.assertEqual(gaps(None, time(17, 0), []), [])

    def test_an_inverted_or_empty_window_yields_nothing(self):
        self.assertEqual(gaps(time(17, 0), time(9, 0), []), [])
        self.assertEqual(gaps(time(9, 0), time(9, 0), []), [])


class SuggestGapsOrderingTests(unittest.TestCase):
    def test_picks_the_longest(self):
        self.assertEqual(
            day_bounds.suggest_gaps([
                (time(9, 0), time(9, 30)),
                (time(11, 0), time(13, 0)),
                (time(15, 0), time(16, 0)),
            ], limit=1),
            [(time(11, 0), time(13, 0))],
        )

    def test_ties_go_to_the_earliest(self):
        self.assertEqual(
            day_bounds.suggest_gaps([
                (time(9, 0), time(10, 0)),
                (time(14, 0), time(15, 0)),
            ]),
            [(time(9, 0), time(10, 0)), (time(14, 0), time(15, 0))],
        )

    def test_no_gaps_means_no_suggestion(self):
        self.assertEqual(day_bounds.suggest_gaps([]), [])


class SuggestGapsThresholdTests(unittest.TestCase):
    def test_short_gaps_are_not_offered(self):
        # A two-minute gap between adjacent entries is not something anyone
        # means to fill, and offering it would put a two-minute task in the
        # form as the default.
        self.assertEqual(day_bounds.suggest_gaps([(time(10, 0), time(10, 2))]), [])

    def test_the_longest_gap_over_the_threshold_wins(self):
        self.assertEqual(
            day_bounds.suggest_gaps([
                (time(9, 0), time(9, 2)),
                (time(10, 0), time(10, 20)),
                (time(12, 0), time(13, 30)),
            ]),
            [(time(12, 0), time(13, 30)), (time(10, 0), time(10, 20))],
        )

    def test_a_long_gap_is_not_hidden_by_a_sliver(self):
        # The sliver is dropped before the longest is chosen, not after — the
        # other order would throw the answer away whenever a sliver came first.
        self.assertEqual(
            day_bounds.suggest_gaps([(time(9, 0), time(9, 1)), (time(10, 0), time(11, 0))]),
            [(time(10, 0), time(11, 0))],
        )

    def test_the_threshold_is_inclusive_and_adjustable(self):
        exactly_five = [(time(10, 0), time(10, 5))]
        self.assertEqual(day_bounds.suggest_gaps(exactly_five), [(time(10, 0), time(10, 5))])
        self.assertEqual(day_bounds.suggest_gaps(exactly_five, minimum_minutes=6), [])

    def test_nothing_to_suggest_from(self):
        self.assertEqual(day_bounds.suggest_gaps([]), [])


class PlanStretchTests(unittest.TestCase):
    def test_a_task_inside_the_day_moves_nothing(self):
        stretch = day_bounds.plan_stretch(time(9, 0), time(17, 0), time(10, 0), time(11, 0))
        self.assertEqual(stretch, day_bounds.Stretch(None, None))
        self.assertFalse(day_bounds.needs_stretch(stretch))

    def test_a_task_ending_after_the_day_moves_the_end(self):
        stretch = day_bounds.plan_stretch(time(9, 0), time(17, 0), time(18, 30), time(19, 15))
        self.assertEqual(stretch, day_bounds.Stretch(None, time(19, 15)))
        self.assertTrue(day_bounds.needs_stretch(stretch))

    def test_a_task_starting_before_the_day_moves_the_start(self):
        stretch = day_bounds.plan_stretch(time(9, 0), time(17, 0), time(7, 45), time(8, 30))
        self.assertEqual(stretch, day_bounds.Stretch(time(7, 45), None))

    def test_a_task_spanning_the_whole_day_moves_both(self):
        stretch = day_bounds.plan_stretch(time(9, 0), time(17, 0), time(8, 0), time(18, 0))
        self.assertEqual(stretch, day_bounds.Stretch(time(8, 0), time(18, 0)))

    def test_touching_the_bounds_exactly_moves_nothing(self):
        stretch = day_bounds.plan_stretch(time(9, 0), time(17, 0), time(9, 0), time(17, 0))
        self.assertEqual(stretch, day_bounds.Stretch(None, None))

    def test_a_day_still_in_progress_has_no_end_to_move(self):
        # An open day contains everything by definition. Proposing a change
        # here would ask the user to confirm something that wouldn't happen.
        stretch = day_bounds.plan_stretch(time(9, 0), None, time(10, 0), time(23, 0))
        self.assertEqual(stretch, day_bounds.Stretch(None, None))

    def test_a_day_with_no_start_gets_one_from_the_task(self):
        # A row with no start is broken rather than open, and anchoring it to
        # the task is strictly better than leaving it unanchored.
        stretch = day_bounds.plan_stretch(None, time(17, 0), time(10, 0), time(11, 0))
        self.assertEqual(stretch, day_bounds.Stretch(time(10, 0), None))


if __name__ == '__main__':
    unittest.main()
