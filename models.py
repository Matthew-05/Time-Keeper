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