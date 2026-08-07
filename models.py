from datetime import datetime

from flask import Flask
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class Client(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True, nullable=False)

    def __repr__(self):
        return f'<Client {self.name}>'

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