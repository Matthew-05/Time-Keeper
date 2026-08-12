"""Closing out the tasks and days that were left open.

The app has no automatic end. A task ends because someone pressed *Complete
task*, and a day ends because someone pressed *End day* — so shutting the laptop
at 5pm on Friday leaves a task running and a day open, and nothing in the app
ever notices. Those two rows then poison everything downstream: an open task has
no duration, so its time is simply absent from History, Summary and every budget;
an open day has no end, so utilisation for that day divides by a capacity the
app can't fill. Both get worse the longer they sit, because the person who could
say what actually happened forgets.

So the app asks, once, at startup — and asks about **exactly one thing**, because
only one thing is genuinely unknown.

**What is unknown: when the last task finished.** Nobody but the user knows, and
no rule can invent it. That's the prompt.

**What is not unknown: everything else.** A task left open in the *middle* of a
day is bounded by the task that follows it — the next task's start time is when
this one stopped, by construction. A task left open on a day that *was* ended is
bounded by the day's own end time. And once every task on a past day has an end,
the day's end follows from its last task, which is the whole point: the day
ended when the work did, not at midnight.

That split is why this module is shaped as two passes rather than one prompt.
``plan_open_tasks`` sorts the derivable from the unknowable and hands back only
the latter; ``plan_day_closures`` runs after the user has answered and needs no
input at all. Anything that *can* be derived is, silently — a dialog that asks
about something the database already implies is a dialog people learn to click
through.

Deliberately free of Flask and SQLAlchemy, the same split ``budgets.py``,
``summary.py`` and ``rounding.py`` already use: ``main.py`` owns the queries and
the writes, this owns the decisions. The decisions are the part with edge cases
worth testing, and they test far better against tuples than against a database.
"""

from collections import namedtuple

# Why a task was closed without asking. Carried through to the caller so the
# sweep can report what it did rather than silently editing history.
NEXT_TASK_START = 'next_task_start'
DAY_END = 'day_end'

#: One task with no end time.
#:
#: ``next_start`` is the start of the earliest *later* task on the same day, or
#: None if this is the day's last task. ``day_end`` is that day's recorded end
#: time, or None if the day was never ended.
OpenTask = namedtuple('OpenTask', 'id date start_time next_start day_end')

#: A task this module closed on its own, and the reason it was allowed to.
AutoClose = namedtuple('AutoClose', 'id end_time reason')

#: One day with no end time. ``last_task_end`` is the latest end time among that
#: day's tasks (None if the day has no tasks, or none of them have ended);
#: ``has_tasks`` distinguishes those two, which get opposite treatment.
OpenDay = namedtuple('OpenDay', 'date start_time has_tasks last_task_end')

#: Dates to close at a given time, and dates to remove entirely.
DayClosures = namedtuple('DayClosures', 'close delete')


def plan_open_tasks(open_tasks):
    """Split open tasks into the ones that can be closed silently and the rest.

    Returns ``(auto, prompt)``: a list of :class:`AutoClose` to apply straight
    away, and the :class:`OpenTask` values that have to be put to the user.

    A later task on the same day wins over the day's end time when both are
    available. Both are upper bounds on when this task stopped, and the next
    task's start is the tighter one — time between two tasks belongs to the
    earlier one, but time after the *last* task and before the day ended may be
    a break, an overrun, or anything else.

    Every derived end is floored at the task's own start time. A next-task start
    that precedes it means the rows are already inconsistent (hand-edited in the
    Task Browser, most likely), and a negative duration would propagate into
    every total that touches it. A zero-length task is visibly wrong in the
    History timeline, which is where someone can actually fix it.
    """
    auto = []
    prompt = []

    for task in open_tasks:
        if task.next_start is not None:
            auto.append(AutoClose(task.id, max(task.next_start, task.start_time), NEXT_TASK_START))
        elif task.day_end is not None:
            auto.append(AutoClose(task.id, max(task.day_end, task.start_time), DAY_END))
        else:
            prompt.append(task)

    return auto, prompt


def plan_day_closures(open_days):
    """Decide what happens to each past day that was never ended.

    Returns a :class:`DayClosures` of ``close`` — ``(date, end_time)`` pairs —
    and ``delete``, the dates whose tracking row should go away.

    **A day with tasks closes at its last task's end.** That is what "the day
    ended" means here: the previous behaviour was to assume 23:59, which turned
    one forgotten click into a fifteen-hour working day and dragged that day's
    utilisation to near zero on the Summary dashboard.

    **A day with no tasks at all is deleted.** *Start day* pressed and nothing
    recorded against it is a mis-start, not a day worked; keeping it would leave
    a row that can never be closed by the rule above and would be offered up for
    closing again on every launch.

    **A day whose tasks all lack end times is left alone.** It can't arise once
    ``plan_open_tasks`` has run and its prompts have been answered, which is the
    only way this function is called — but "no derivable end" must never fall
    through to the delete branch, because that would take real tracked work with
    it. Left open, it simply comes back next launch.
    """
    close = []
    delete = []

    for day in open_days:
        if day.last_task_end is not None:
            end = day.last_task_end
            # Same flooring as above, for the same reason: a day cannot end
            # before it started, whatever the rows say.
            if day.start_time is not None:
                end = max(end, day.start_time)
            close.append((day.date, end))
        elif not day.has_tasks:
            delete.append(day.date)

    return DayClosures(close, delete)
