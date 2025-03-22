from flask import Flask
from flask_sqlalchemy import SQLAlchemy

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///clients.db'
db = SQLAlchemy(app)

class Client(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True, nullable=False)

    def __repr__(self):
        return f'<Client {self.name}>'

class Task_Item(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    start_time = db.Column(db.Time, nullable=False)
    end_time = db.Column(db.Time, nullable=False)
    client_id = db.Column(db.Integer, db.ForeignKey('client.id'), nullable=False)
    client = db.relationship('Client', backref=db.backref('tasks', lazy=True))
    type = db.Column(db.String(50), nullable=False)
    description = db.Column(db.Text, nullable=False)
    time_spent = db.Column(db.Integer, nullable=False)
    adjust_entry = db.Column(db.Boolean, default=False)

    def __repr__(self):
        return f'<Task_Item {self.date} {self.start_time}-{self.end_time} Client: {self.client_id}>'
