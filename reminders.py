"""The "describe what you're working on" reminder.

A single background thread that watches one number: how long it's been since
the active task's description was last saved. When that passes the configured
interval it raises a Windows toast, and keeps doing so every interval until you
either update the description, finish the task, or snooze.

Three decisions worth spelling out:

**The clock measures inactivity, not wall time.** The anchor is reset by
``mark_activity`` — called whenever a description is written — so a reminder
only ever means "you haven't touched this in a while." Typing something at
minute 29 buys you another full interval rather than a notification 60 seconds
later, which is what a fixed cadence would do and is exactly the behaviour that
trains people to dismiss notifications without reading them.

**Silence is the default when there's nothing to say.** No open task, or the day
never started, means no reminder — and the anchor is *dropped* rather than
paused, so starting a task at 4pm gives you a fresh interval instead of a toast
the moment you begin. Deciding that is the ``probe`` callback's job; this module
deliberately knows nothing about the database.

**A hold is scoped to a task, not to a duration.** "Until next task" records
*which* task you were on rather than a time to wake up at, so it lifts on its own
the moment the active task changes — whether that's minutes or hours later, and
whether the current one is completed, replaced, or the day ends. Nothing has to
remember to cancel it.

**Settings are read every tick, not cached.** Changing the interval on the
settings page takes effect on the next tick, including for a countdown already
in flight, because the due time is recomputed from the anchor rather than
stored. Enabling and disabling likewise need no restart.

The thread is a daemon and every exception inside the loop is swallowed and
logged. A reminder that stops working is an annoyance; a reminder that takes the
process down with it is a bug report.
"""

import logging
import threading
import time

logger = logging.getLogger('timekeeper')

# How often the loop wakes to re-evaluate. Fine-grained enough that a snooze or
# an interval change feels immediate, coarse enough to be free.
TICK_SECONDS = 5

TITLE = 'What are you working on?'
BODY = "Time Keeper hasn't seen a description for your current task in {elapsed}."
BODY_NEVER = "Your current task still doesn't have a description."


def _humanise(seconds):
    """`5400` -> `'1h 30m'`. Used only in notification copy."""
    minutes = max(1, int(round(seconds / 60)))
    hours, minutes = divmod(minutes, 60)
    if hours and minutes:
        return f'{hours}h {minutes}m'
    if hours:
        return f'{hours}h'
    return f'{minutes}m'


class ReminderService:
    """Owns the reminder timer. One instance, started once from ``main``.

    Args:
        probe: ``() -> task id or None``. The identity of the task worth
            describing right now, or None when there isn't one. It returns an
            id rather than a bool so a hold can tell "still the same task" from
            "a new one started". Called from the timer thread, so it must open
            its own app context.
        notifier: module or object exposing ``send(title, message, actions)``
            and ``available()`` — ``notifications`` in practice, swappable in
            tests.
        settings_module: exposes ``load_settings()``.
        clock: monotonic time source, injectable so tests don't have to sleep.
    """

    def __init__(self, probe, notifier, settings_module, clock=time.monotonic):
        self._probe = probe
        self._notifier = notifier
        self._settings = settings_module
        self._clock = clock

        # Guards every underscore attribute below. Held only for assignments —
        # never across a notification or a probe, both of which are slow.
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._thread = None
        self._stopping = False

        self._anchor = None  # Monotonic time of the last activity or fire.
        self._snooze_until = None
        # The task "until next task" was pressed on. Held until probe() reports
        # a different one — see the module docstring.
        self._held_task_id = None
        self._eligible = False
        self._last_sent_at = None  # Wall clock, for the dev status panel.
        self._last_error = None
        self._sent_count = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        """Spin up the timer thread. Safe to call twice; the second is a no-op."""
        if self._thread is not None:
            return

        self._thread = threading.Thread(
            target=self._loop, name='reminder-timer', daemon=True
        )
        self._thread.start()
        logger.debug('Reminder service started')

    def stop(self):
        """Ask the thread to finish. It's a daemon, so this is politeness."""
        self._stopping = True
        self._wake.set()

    # -- events from the app ----------------------------------------------

    def mark_activity(self):
        """A description was saved (or a task started). Restart the countdown."""
        with self._lock:
            self._anchor = self._clock()
            self._snooze_until = None
        self._wake.set()

    def clear(self):
        """Forget the countdown entirely — nothing to remind about right now."""
        with self._lock:
            self._anchor = None
            self._snooze_until = None
            self._held_task_id = None

    def snooze(self):
        """Push the next reminder out by the configured snooze. Returns minutes."""
        minutes = self._settings.load_settings()['reminder_snooze_minutes']
        with self._lock:
            self._snooze_until = self._clock() + minutes * 60
        self._wake.set()
        logger.debug(f'Reminder snoozed for {minutes} minutes')
        return minutes

    def hold_until_next_task(self):
        """Go quiet about the current task. Returns its id, or None if idle.

        Probes rather than reading the last tick's value: the click arrives on a
        request thread up to a full tick after that was taken, and holding the
        *wrong* task id would silence the new task instead of the old one.
        """
        task_id = self._probe()
        if task_id is None:
            # Nothing running — there's nothing to be quiet about, and recording
            # None would mean "held forever".
            return None

        with self._lock:
            self._held_task_id = task_id
            self._snooze_until = None
        self._wake.set()
        logger.debug(f'Reminders held until a task other than {task_id} starts')
        return task_id

    # -- the timer ---------------------------------------------------------

    def _loop(self):
        while not self._stopping:
            try:
                self._tick()
            except Exception as exc:
                # Anything at all — a database hiccup in the probe, a corrupt
                # settings file mid-write. Log it and take the next tick.
                logger.error(f'Reminder tick failed: {exc}')

            self._wake.wait(TICK_SECONDS)
            self._wake.clear()

    def _tick(self):
        prefs = self._settings.load_settings()

        if not prefs['reminder_enabled']:
            self.clear()
            with self._lock:
                self._eligible = False
            return

        active_id = self._probe()
        with self._lock:
            self._eligible = active_id is not None

        if active_id is None:
            # Dropping the anchor rather than freezing it is the whole reason
            # a task started after a long gap doesn't fire immediately.
            self.clear()
            return

        now = self._clock()
        interval = prefs['reminder_interval_minutes'] * 60

        with self._lock:
            if self._held_task_id is not None:
                if self._held_task_id == active_id:
                    return  # Same task the hold was placed on. Stay quiet.
                # A different task is running, so the hold has served its
                # purpose. Start this one's countdown from scratch.
                self._held_task_id = None
                self._anchor = now
                return

            if self._anchor is None:
                # First tick with something to describe: start counting now.
                self._anchor = now
                return

            # A snooze names the next due time outright rather than adding to
            # the natural one. Snooze is pressed *on* a reminder, and firing has
            # already pushed the anchor a full interval out — so treating the
            # snooze as a floor would make the button do nothing at all whenever
            # the snooze is shorter than the interval, which is the default.
            due = (
                self._snooze_until
                if self._snooze_until is not None
                else self._anchor + interval
            )

            if now < due:
                return

            elapsed = now - self._anchor
            self._anchor = now
            self._snooze_until = None
            snooze_minutes = prefs['reminder_snooze_minutes']

        # Outside the lock: showing a toast shells out to PowerShell and takes
        # long enough that holding the lock would block the request threads.
        self._send(elapsed, snooze_minutes)

    def _send(self, elapsed_seconds, snooze_minutes, reason='timer'):
        body = (
            BODY.format(elapsed=_humanise(elapsed_seconds))
            if elapsed_seconds is not None
            else BODY_NEVER
        )
        # Windows lays buttons out in a single row and truncates to fit, so
        # these stay terse. Three is comfortable; five is the hard limit.
        actions = [
            (f'Snooze {snooze_minutes} min', 'timekeeper://snooze'),
            ('Until next task', 'timekeeper://snooze-task'),
            ('Open Time Keeper', 'timekeeper://open'),
        ]

        sent, error = self._notifier.send(TITLE, body, actions=actions)

        with self._lock:
            self._last_error = error
            if sent:
                self._last_sent_at = time.time()
                self._sent_count += 1

        if sent:
            logger.debug(f'Reminder notification sent ({reason})')
        else:
            logger.warning(f'Reminder notification not sent ({reason}): {error}')

        return sent, error

    # -- introspection -----------------------------------------------------

    def trigger_now(self, reason='manual'):
        """Fire a reminder immediately, ignoring the clock and eligibility.

        This is what the dev-mode test button calls. It resets the countdown
        too, so testing doesn't leave a real reminder due seconds later.
        """
        prefs = self._settings.load_settings()
        now = self._clock()

        with self._lock:
            elapsed = None if self._anchor is None else now - self._anchor
            self._anchor = now
            self._snooze_until = None

        return self._send(elapsed, prefs['reminder_snooze_minutes'], reason=reason)

    def status(self):
        """A snapshot for the dev-mode panel. Cheap; no probe, no I/O."""
        prefs = self._settings.load_settings()
        now = self._clock()

        with self._lock:
            if self._anchor is None:
                seconds_until_due = None
            else:
                # Mirrors _tick: a snooze replaces the natural due time.
                due = (
                    self._snooze_until
                    if self._snooze_until is not None
                    else self._anchor + prefs['reminder_interval_minutes'] * 60
                )
                seconds_until_due = max(0, int(due - now))

            return {
                'enabled': prefs['reminder_enabled'],
                'interval_minutes': prefs['reminder_interval_minutes'],
                'snooze_minutes': prefs['reminder_snooze_minutes'],
                'eligible': self._eligible,
                'running': self._thread is not None and self._thread.is_alive(),
                'notifications_available': self._notifier.available(),
                'unavailable_reason': self._notifier.unavailable_reason(),
                'seconds_until_due': seconds_until_due,
                'snoozed': self._snooze_until is not None
                and self._snooze_until > now,
                'held_task_id': self._held_task_id,
                'sent_count': self._sent_count,
                'last_sent_at': self._last_sent_at,
                'last_error': self._last_error,
            }
