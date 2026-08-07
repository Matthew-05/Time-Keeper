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

    __table_args__ = (
        # Every read is "this client's budgets, and which of them cover this
        # date" — the allocator asks it once per client it touches.
        db.Index('ix_budget_client_dates', 'client_id', 'start_date', 'end_date'),
        db.CheckConstraint('end_date >= start_date', name='ck_budget_dates_ordered'),
        db.CheckConstraint('budgeted_hours > 0', name='ck_budget_hours_positive'),
    )

    def __repr__(self):
        return f'<Budget {self.name!r} {self.start_date}..{self.end_date} {self.budgeted_hours}h>'


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