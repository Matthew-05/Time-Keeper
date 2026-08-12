"""The rules for closing out tasks and days that were left open.

The point of these tests is the *split*: which open rows the app is allowed to
settle on its own and which it must stop and ask about. Getting that wrong in
either direction is bad in a different way — asking about something derivable
trains people to click through the dialog, and deriving something unknowable
invents billable time nobody can vouch for.

The delete branch gets the most attention because it is the only destructive
one, and the case it must never fire on (a day whose tasks are all still open)
is exactly the case that looks identical to an empty day from the outside.
"""

import unittest
from datetime import date, time

import day_close


def open_task(task_id, *, start, next_start=None, day_end=None, on=date(2026, 8, 10)):
    return day_close.OpenTask(
        id=task_id, date=on, start_time=start, next_start=next_start, day_end=day_end
    )


class OpenTaskPlanTests(unittest.TestCase):
    def test_the_last_task_of_an_unended_day_has_to_be_asked_about(self):
        # The one genuinely unknowable case, and the only one worth a dialog.
        _, prompt = day_close.plan_open_tasks([open_task(1, start=time(14, 0))])
        self.assertEqual([task.id for task in prompt], [1])

    def test_a_task_followed_by_another_closes_at_that_one_s_start(self):
        auto, prompt = day_close.plan_open_tasks([
            open_task(1, start=time(9, 0), next_start=time(11, 30)),
        ])
        self.assertEqual(prompt, [])
        self.assertEqual(auto, [day_close.AutoClose(1, time(11, 30), day_close.NEXT_TASK_START)])

    def test_a_task_on_an_ended_day_closes_at_the_day_s_end(self):
        auto, prompt = day_close.plan_open_tasks([
            open_task(1, start=time(16, 0), day_end=time(17, 30)),
        ])
        self.assertEqual(prompt, [])
        self.assertEqual(auto, [day_close.AutoClose(1, time(17, 30), day_close.DAY_END)])

    def test_the_next_task_wins_over_the_day_end(self):
        # Both bound it, but only the next task's start is tight: whatever
        # happened between the last task and the end of the day may not have
        # been this task.
        auto, _ = day_close.plan_open_tasks([
            open_task(1, start=time(9, 0), next_start=time(10, 0), day_end=time(17, 0)),
        ])
        self.assertEqual(auto[0].end_time, time(10, 0))
        self.assertEqual(auto[0].reason, day_close.NEXT_TASK_START)

    def test_a_derived_end_never_precedes_the_start(self):
        # Reachable by hand-editing a start time forward in the Task Browser.
        # A zero-length task is visibly wrong; a negative one silently
        # subtracts from every total it touches.
        auto, _ = day_close.plan_open_tasks([
            open_task(1, start=time(15, 0), next_start=time(9, 0)),
            open_task(2, start=time(15, 0), day_end=time(9, 0)),
        ])
        self.assertEqual([closure.end_time for closure in auto], [time(15, 0), time(15, 0)])

    def test_two_open_tasks_on_one_day_leave_only_the_later_to_ask_about(self):
        auto, prompt = day_close.plan_open_tasks([
            open_task(1, start=time(9, 0), next_start=time(13, 0)),
            open_task(2, start=time(13, 0)),
        ])
        self.assertEqual([closure.id for closure in auto], [1])
        self.assertEqual([task.id for task in prompt], [2])

    def test_nothing_open_means_nothing_to_do(self):
        self.assertEqual(day_close.plan_open_tasks([]), ([], []))


def open_day(*, has_tasks, last_task_end=None, start=time(9, 0), on=date(2026, 8, 10)):
    return day_close.OpenDay(
        date=on, start_time=start, has_tasks=has_tasks, last_task_end=last_task_end
    )


class DayClosurePlanTests(unittest.TestCase):
    def test_a_day_closes_at_its_last_task_s_end(self):
        plan = day_close.plan_day_closures([open_day(has_tasks=True, last_task_end=time(17, 12))])
        self.assertEqual(plan.close, [(date(2026, 8, 10), time(17, 12))])
        self.assertEqual(plan.delete, [])

    def test_a_day_with_nothing_recorded_is_removed(self):
        plan = day_close.plan_day_closures([open_day(has_tasks=False)])
        self.assertEqual(plan.close, [])
        self.assertEqual(plan.delete, [date(2026, 8, 10)])

    def test_a_day_whose_tasks_are_all_still_open_is_left_alone(self):
        # The destructive branch must key on "no tasks", not on "no end time to
        # derive" — those look the same here and deleting this one would take
        # real tracked work with it.
        plan = day_close.plan_day_closures([open_day(has_tasks=True, last_task_end=None)])
        self.assertEqual(plan.close, [])
        self.assertEqual(plan.delete, [])

    def test_a_close_never_precedes_the_day_s_start(self):
        plan = day_close.plan_day_closures([
            open_day(has_tasks=True, start=time(10, 0), last_task_end=time(8, 0)),
        ])
        self.assertEqual(plan.close, [(date(2026, 8, 10), time(10, 0))])

    def test_a_day_with_no_recorded_start_still_closes(self):
        plan = day_close.plan_day_closures([
            open_day(has_tasks=True, start=None, last_task_end=time(16, 45)),
        ])
        self.assertEqual(plan.close, [(date(2026, 8, 10), time(16, 45))])

    def test_days_are_planned_independently(self):
        plan = day_close.plan_day_closures([
            open_day(on=date(2026, 8, 10), has_tasks=True, last_task_end=time(17, 0)),
            open_day(on=date(2026, 8, 11), has_tasks=False),
            open_day(on=date(2026, 8, 12), has_tasks=True, last_task_end=time(12, 30)),
        ])
        self.assertEqual(plan.close, [
            (date(2026, 8, 10), time(17, 0)),
            (date(2026, 8, 12), time(12, 30)),
        ])
        self.assertEqual(plan.delete, [date(2026, 8, 11)])


if __name__ == '__main__':
    unittest.main()
