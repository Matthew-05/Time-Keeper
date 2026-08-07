from datetime import datetime

from flask import Flask
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class Client(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True, nullable=False)

    def __repr__(self):
        return f'<Client {self.name}>'

class Budget(db.Model):
    """A pot of hours for one client over one date range.

    An engagement, a retainer month, an SOW — whatever the name, the shape is
    the same: this client, these dates, this many hours. Nothing is stored
    about how much has been *used*; consumption is derived from the tasks every
    time it's asked for (see ``budgets.py``). A cached total would be wrong the
    moment an entry was edited in the Task Browser, which happens constantly.

    Ranges are inclusive at both ends and are deliberately allowed to overlap —
    two concurrent engagements for the same client is a real situation, and the
    allocator has a defined answer for it (earliest end date first, then spill).
    """
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    # NOT NULL + CASCADE, like Work: a budget for a client that no longer
    # exists has nothing to measure against. Note SQLite runs with foreign_keys
    # OFF, so this is documentation — delete_client() in main.py does the work.
    client_id = db.Column(
        db.Integer,
        db.ForeignKey('client.id', ondelete='CASCADE'),
        nullable=False,
    )
    client = db.relationship(
        'Client',
        backref=db.backref('budgets', lazy=True, passive_deletes=True),
    )
    start_date = db.Column(db.Date, nullable=False)
    end_date = db.Column(db.Date, nullable=False)  # Inclusive.
    budgeted_hours = db.Column(db.Float, nullable=False)
    notes = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)
    # A manual close is distinct from the scheduled end date. Keeping both
    # preserves the original commitment while letting the allocator stop
    # sending later work into a budget that was deliberately wrapped up.
    closed_at = db.Column(db.DateTime, nullable=True)

    __table_args__ = (
        # Every read is "this client's budgets, and which of them cover this
        # date" — the allocator asks it once per client it touches.
        db.Index('ix_budget_client_dates', 'client_id', 'start_date', 'end_date'),
        db.CheckConstraint('end_date >= start_date', name='ck_budget_dates_ordered'),
        db.CheckConstraint('budgeted_hours > 0', name='ck_budget_hours_positive'),
    )

    def __repr__(self):
        return f'<Budget {self.name!r} {self.start_date}..{self.end_date} {self.budgeted_hours}h>'


class BudgetHold(db.Model):
    """A stretch of a budget's range during which the project was on hold.

    Projects get paused — the client goes quiet, an approval is outstanding,
    the work is blocked on somebody else. Those days are inside the budget's
    range but nobody was ever going to work them, and counting them as working
    time is what makes every statistic wrong: the projection sags, the pace
    reads low, and the burn chart's ideal line climbs against an actual that
    can't move.

    So a hold is modelled as **days that contribute no capacity**, which is
    exactly what a weekend already is. `budgets.day_capacity()` returns 0.0 for
    both, and every figure downstream — projection, pace, capacity share, the
    ideal line — corrects itself without knowing holds exist.

    Stored as intervals rather than a flag on `Budget` deliberately. A flag can
    only describe *now*; it can't say which days were dead, so it can't fix any
    of the arithmetic, and it has no answer for a project paused twice or for a
    hold entered after the fact. Intervals handle all three.

    ``end_date IS NULL`` means the hold is still running. Its future is
    unknowable, so it counts as held **up to today and no further** — see
    `budgets.hold_days()`. Assuming the pause continues to the budget's end
    would wipe out the remaining capacity and make `required_hours_per_day`
    read as impossible while the project is merely waiting on a phone call.

    Holds do **not** change allocation. Time recorded on a held day still pours
    into the budget exactly as before, because "a client's hours always
    reconcile" is load-bearing in `budgets.allocate()`. It is instead reported
    as `held_hours`, which is usually the signal that the hold dates are wrong.
    """
    __tablename__ = 'budget_hold'

    id = db.Column(db.Integer, primary_key=True)
    budget_id = db.Column(
        db.Integer,
        db.ForeignKey('budget.id', ondelete='CASCADE'),
        nullable=False,
    )
    budget = db.relationship(
        'Budget',
        # No passive_deletes: SQLite runs with foreign_keys OFF, so the CASCADE
        # above is documentation and SQLAlchemy has to issue the DELETEs. A
        # hold has no meaning without its budget, so delete-orphan is right —
        # unlike time entries, which must always survive.
        backref=db.backref('holds', lazy=True, cascade='all, delete-orphan'),
    )
    start_date = db.Column(db.Date, nullable=False)
    end_date = db.Column(db.Date, nullable=True)  # Inclusive. NULL = still held.
    reason = db.Column(db.String(200), nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    __table_args__ = (
        # Every read is "this budget's holds", and they're applied in date order.
        db.Index('ix_budget_hold_budget_dates', 'budget_id', 'start_date'),
        db.CheckConstraint(
            'end_date IS NULL OR end_date >= start_date',
            name='ck_budget_hold_dates_ordered',
        ),
    )

    def __repr__(self):
        end = self.end_date or 'open'
        return f'<BudgetHold budget={self.budget_id} {self.start_date}..{end}>'


class Task_Item(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)  # Start date is required
    start_time = db.Column(db.Time, nullable=False)  # Start time is required
    end_time = db.Column(db.Time, nullable=True)  # Nullable end time
    client_id = db.Column(
        db.Integer,
        db.ForeignKey('client.id', ondelete='SET NULL'),
        nullable=True,
    )
    client = db.relationship('Client', backref=db.backref('tasks', lazy=True))
    type = db.Column(db.String(50), nullable=True)  # Type is not required
    description = db.Column(db.Text, nullable=True)  # Description is not required
    time_spent = db.Column(db.Integer, nullable=True)  # Time spent is not required
    adjust_entry = db.Column(db.Boolean, default=False)  # Default is False
    # Manual override of the bucket-fill allocator (see budgets.py). NULL — the
    # overwhelmingly common case — means "let the allocator decide"; a value
    # pins this entry to one budget and takes it out of the pour entirely.
    # SET NULL rather than CASCADE: deleting a budget must never delete time.
    budget_id = db.Column(
        db.Integer,
        db.ForeignKey('budget.id', ondelete='SET NULL'),
        nullable=True,
        index=True,
    )
    budget = db.relationship('Budget', backref=db.backref('pinned_tasks', lazy=True))
    # Distinguishes an explicit "No budget" choice from budget_id=NULL, which
    # means the entry should continue through the automatic allocator.
    budget_excluded = db.Column(db.Boolean, nullable=False, default=False)

class Work(db.Model):
    """One thing you did for a client on a day.

    Deliberately keyed on (client, date) rather than on a task: a client's work
    for the day is a single list no matter how many separate time blocks it was
    spread across, and that list is what gets copied out at the end of the day.
    `Task_Item.description` is the superseded per-task version of this — the
    column is still present but nothing reads or writes it.

    The unique constraint is exact-match; the API layer additionally rejects
    case-insensitive duplicates, so this is a backstop rather than the check
    the user actually meets.
    """
    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    # NOT NULL + CASCADE: a work has no meaning without its client, so deleting
    # a client takes its works with it. This is the one place that deliberately
    # differs from Task_Item, which goes nullable/SET NULL so historical time
    # survives under a "removed client" group.
    client_id = db.Column(
        db.Integer,
        db.ForeignKey('client.id', ondelete='CASCADE'),
        nullable=False,
    )
    client = db.relationship(
        'Client',
        backref=db.backref('works', lazy=True, passive_deletes=True),
    )
    text = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.now)

    __table_args__ = (
        db.UniqueConstraint('date', 'client_id', 'text', name='uq_work_date_client_text'),
        # Every read is "this client, this day", ordered by insertion.
        db.Index('ix_work_date_client', 'date', 'client_id'),
    )

    def __repr__(self):
        return f'<Work {self.date} {self.client_id} {self.text!r}>'

class TimeTracking(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date)
    start_time = db.Column(db.Time)
    end_time = db.Column(db.Time)
    offset = db.Column(db.Integer)
    pause_time = db.Column(db.Time)

class BreakTracking(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date)
    start_time = db.Column(db.Time)
    end_time = db.Column(db.Time)
    total_seconds = db.Column(db.Integer)
