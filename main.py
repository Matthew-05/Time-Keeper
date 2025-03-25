from flask import Flask, render_template, request, jsonify, redirect, url_for
from models import db, Client, Task_Item, TimeTracking, BreakTracking
import threading
import time
from datetime import datetime, date, timedelta
from sqlalchemy import text, inspect, desc, and_
from flask_migrate import Migrate
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView
import webview
import sys
from werkzeug.serving import run_simple
from werkzeug.middleware.dispatcher import DispatcherMiddleware
import os
from sqlalchemy import func

DEV_MODE = os.environ.get('DEV_MODE', 'False').lower() == 'true'

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_secret_key_here'  
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///clients.db'
db.init_app(app)
migrate = Migrate(app, db)

timer_running = False
timer_value = 0

def timer_thread():
    global timer_running, timer_value
    while True:
        if timer_running:
            timer_value += 1
            print(f"Timer value: {timer_value}")
        time.sleep(1)

@app.route('/start_timer')
def start_timer():
    print("Started timer")
    global timer_running
    timer_running = True
    timer_thread()
    return jsonify({'message': 'Timer started'})

@app.route('/stop_timer')
def stop_timer():
    print("Stopped timer")
    global timer_running
    timer_running = False
    return jsonify({'message': 'Timer stopped'})

@app.route('/timer_status')
def timer_status():
    global timer_running, timer_value
    return jsonify({'running': timer_running, 'value': timer_value})


with app.app_context():
    db.create_all()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/clients', methods=['GET'])
def get_clients():
    query = request.args.get('query', '')
    clients = Client.query.filter(Client.name.like(f'%{query}%')).all() if query else Client.query.all()
    return jsonify([{'id': client.id, 'name': client.name} for client in clients])

@app.route('/autocomplete', methods=['GET'])
def autocomplete():
    search_query = request.args.get('query', '')
    if search_query:
        clients = Client.query.filter(Client.name.ilike(f'%{search_query}%')).all()
    else:
        clients = Client.query.all()
    results = [client.name for client in clients]
    return jsonify(results)

@app.route('/clients', methods=['POST'])
def create_client():
    data = request.get_json()
    name = data.get('name')
    if name:
        if not Client.query.filter_by(name=name).first():
            new_client = Client(name=name)
            db.session.add(new_client)
            db.session.commit()
            return jsonify({'success': True}), 201
        return jsonify({'error': 'Client already exists'}), 400
    return jsonify({'error': 'Name field is required'}), 400

@app.route('/clients/<int:id>', methods=['GET'])
def get_client(id):
    client = Client.query.get(id)
    return jsonify({'id': client.id, 'name': client.name})

@app.route('/clients/<int:id>', methods=['PUT'])
def update_client(id):
    client = Client.query.get(id)
    client.name = request.json['name']
    db.session.commit()
    return jsonify({'success': True})

@app.route('/clients/<int:id>', methods=['DELETE'])
def delete_client(id):
    client = Client.query.get(id)
    db.session.delete(client)
    db.session.commit()
    return jsonify({'success': True})

@app.route('/client_manager')
def client_manager():
    clients = Client.query.all()
    return render_template('client_manager.html', clients=clients)

@app.route('/new_client', methods=['GET', 'POST'])
def new_client():
    if request.method == 'POST':
        name = request.form['name']
        if not Client.query.filter_by(name=name).first():
            new_client = Client(name=name)
            db.session.add(new_client)
            db.session.commit()
            return redirect(url_for('client_manager'))
        return jsonify({'error': 'Client already exists'}), 400
    return render_template('new_client.html')

@app.route('/get_breaks', methods=['POST'])
def get_breaks():
    data = request.json
    submitted_date = data.get('date')
    if submitted_date:
        try:
            date_obj = datetime.strptime(submitted_date, '%Y-%m-%d').date()
            breaks = BreakTracking.query.filter(BreakTracking.date == date_obj).all()
            breaks_data = [{
                'id': break_item.id,
                'date': break_item.date.strftime('%Y-%m-%d'),
                'start_time': break_item.start_time.strftime('%H:%M:%S') if break_item.start_time else None,
                'end_time': break_item.end_time.strftime('%H:%M:%S') if break_item.end_time else None,
                'total_seconds': break_item.total_seconds
            } for break_item in breaks]
            return jsonify(breaks_data)
        except ValueError:
            return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400
    else:
        return jsonify({'error': 'Date is required.'}), 400
    
@app.route('/get_day_data', methods=['POST'])
def get_day_data():
    data = request.json
    submitted_date = data.get('date')
    if submitted_date:
        try:
            print(submitted_date)
            date_obj = datetime.strptime(submitted_date, '%Y-%m-%d').date()
            day_data = TimeTracking.query.filter(TimeTracking.date == date_obj).first()
            print(day_data)
            day_data = {
                "start_time" : day_data.start_time.strftime('%H:%M:%S') if day_data.start_time else None,
                "end_time" : day_data.end_time.strftime('%H:%M:%S') if day_data.end_time else None,
            }
            return jsonify(day_data)
        except ValueError:
            return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400
    else:
        return jsonify({'error': 'Date is required.'}), 400



@app.route('/task_browser')
def task_browser():
    return render_template('task_browser.html')

@app.route('/tasks/<date>')
def get_tasks(date):
    date_obj = datetime.strptime(date, '%Y-%m-%d').date()
    print(date)
    print(Task_Item.query.all()[0].date)
    tasks = Task_Item.query.filter_by(date=date_obj).all()
    tasks_data = [{
        'id': task.id,
        'date': task.date.strftime('%Y-%m-%d'),
        'start_time': task.start_time.strftime('%H:%M:%S'),
        'end_time': task.end_time.strftime('%H:%M:%S') if task.end_time else '',
        'client_id': task.client_id,
        'client_name': task.client.name,
        'type': task.type,
        'description': task.description,
        'time_spent': task.time_spent,
        'adjust_entry': task.adjust_entry
    } for task in tasks]
    print(tasks_data)
    return jsonify(tasks_data)

@app.route('/unfinished_tasks', methods=['GET'])
def get_unfinished_tasks():
    today = date.today()
    unfinished_tasks = Task_Item.query.filter_by(date=today, end_time=None).all()
    tasks_data = [{
        'id': task.id,
        'client': task.client.name,
        'description': task.description,
        'start_time': task.start_time.strftime('%H:%M:%S')
    } for task in unfinished_tasks]
    return jsonify(tasks_data)

@app.route('/complete_task', methods=['POST'])
def complete_task():
    print("Completing task")
    data = request.json
    client_name = data.get('client')
    end_time = data.get('endTime')
    description = data.get('description')
    type = data.get('type')
    print("submitted end time", end_time)
    datetime_obj = datetime.strptime(end_time, '%I:%M %p').time()
    date = datetime.now().date()

    if not client_name:
        print("no client name")
        return jsonify({'error': 'Client name is required'}), 400

    client = Client.query.filter_by(name=client_name).first()
    if not client:
        print("no client")
        client = Client(name=client_name)
        db.session.add(client)
        db.session.commit()

    existing_entry = Task_Item.query.filter_by(date=date, end_time = None).first()
    print("existing entry", existing_entry)
    if existing_entry:
        print("updating new entry")
        print("time to save", datetime_obj)
        existing_entry.client_id = client.id
        existing_entry.description = description
        existing_entry.type = type
        existing_entry.end_time = datetime_obj
        db.session.commit()
        return jsonify({'success': True}), 201
    else:
        print("failed to find existing entry")
        return jsonify({'error': 'No existing entry'}), 400
      

@app.route('/add_unfinished_task', methods=['POST'])
def add_unfinished_task():
    data = request.json
    client_name = data.get('client')
    now = datetime.now()
    start_date = now.date()
    start_time = data.get('startTime')
    print("submitted start time", start_time)
    datetime_obj = datetime.strptime(start_time, '%I:%M %p').time()


    client = Client.query.filter_by(name=client_name).first()
    if not client:
        client = Client(name=client_name)
        db.session.add(client)
        db.session.commit()

    new_task = Task_Item(
        date=start_date,
        start_time=datetime_obj,
        end_time=None,
        client=client,
        type=None,
        description=None,
        time_spent=0
    )

    print(new_task)
    db.session.add(new_task)
    db.session.commit()
    return jsonify({'success': True}), 201

@app.route('/start_day', methods=['POST'])
def start_day():
    print("starting day")
    today = datetime.now().date()
    data = request.json
    submitted_time = data.get('time')
    datetime_obj = datetime.strptime(submitted_time, '%I:%M %p').time()
    existing_entry = TimeTracking.query.filter_by(date=today).first()
    if existing_entry:
        return jsonify({'message': 'Day already started'}), 400

    new_entry = TimeTracking(date=today, start_time=datetime_obj)
    db.session.add(new_entry)
    db.session.commit()
    return jsonify({'message': 'Day started successfully'}), 201

@app.route('/end_day', methods=['PUT'])
def end_day():
    print("ending day")
    today = datetime.now().date()
    existing_entry = TimeTracking.query.filter_by(date=today).first()
    if not existing_entry:
        return jsonify({'error': 'Day has not been started yet'}), 400

    existing_entry.end_time = datetime.now().time()
    db.session.commit()
    return jsonify({'message': 'Day ended successfully'}), 200

@app.route('/check_tasks_for_today')
def check_tasks_for_today():
    today = date.today()
    tasks_for_today = Task_Item.query.filter_by(date=today).all()
    return jsonify({'tasks_exist': bool(tasks_for_today)})

@app.route('/check_day_status')
def check_day_status():
    # Get today's date
    today = date.today()
    print(today)
    
    # Check if there are any task items (completed or incomplete) for today
    tasks_for_today = Task_Item.query.filter_by(date=today, end_time=None).all()
    day_started_status = TimeTracking.query.filter_by(date=today).all() ## will return 0 if day has not been started
    on_break_time_status = BreakTracking.query.filter(and_(BreakTracking.date == today, BreakTracking.start_time.isnot(None),BreakTracking.end_time == None )).all()
    print(TimeTracking.query.filter_by(pause_time=None).all())
    print(tasks_for_today)
    print("on break time status", on_break_time_status)

    day_ended_status = False
    if day_started_status:
        day_ended_query = TimeTracking.query.filter_by(date=today).all()
        print(day_ended_query, "day ended query")
        if day_ended_query[0].end_time != None:
            print("here")
            day_ended_status = True

    print("day ended status",day_ended_status)

    print(bool(len(day_started_status)>0 ), "day currently open status" )
    
    # Return a JSON response indicating whether there are any task items for today
    ## break time status works like this: checks 
    return jsonify({'dayStarted': bool(len(day_started_status)>0),'unfinishedTasksExist': bool(len(tasks_for_today)>0), 'dayEnded': day_ended_status, 'breakTimeStarted': bool(len(on_break_time_status)>0)})

@app.route('/reopen_day', methods=['PUT'])
def reopen_day():
    today = datetime.now().date()
    existing_entry = TimeTracking.query.filter_by(date=today).first()
    if existing_entry:
        # Clear the end time in the entry for the current day
        existing_entry.end_time = None
        db.session.commit()
        return jsonify({'message': 'Day reopened successfully'}), 200
    else:
        return jsonify({'error': 'Day has not been started yet'}), 400
    
@app.route('/start_break', methods=['POST'])
def start_break():
    today = datetime.now().date()
    data = request.json
    submitted_time = data.get('time')
    datetime_obj = datetime.strptime(submitted_time, '%I:%M %p').time()
    # Create a new entry for the break
    new_entry = BreakTracking(date=today, start_time=datetime_obj)
    db.session.add(new_entry)
    db.session.commit()
    return jsonify({'message': 'Break started successfully'}), 200

@app.route('/end_break', methods=['post'])
def end_break():
    today = datetime.now().date()
    existing_entry = BreakTracking.query.filter_by(date=today).first()
    print(existing_entry)
    data = request.json
    submitted_time = data.get('time')
    print(submitted_time)
    datetime_obj = datetime.strptime(submitted_time, '%I:%M %p').time()
    if existing_entry:
        print(datetime_obj)
        existing_entry.end_time = datetime_obj
        db.session.commit()

        return jsonify({'message': 'Break ended successfully'}), 200

    else:
        return jsonify({'error': 'Day has not been started yet'}), 400

@app.route('/get_time_tracking/<date_str>', methods=['GET'])
def get_time_tracking(date_str):
    try:
        date_obj = datetime.strptime(date_str, '%Y-%m-%d').date()
    except ValueError:
        return jsonify({'error': 'Invalid date format. Use YYYY-MM-DD.'}), 400

    time_tracking_entry = TimeTracking.query.filter_by(date=date_obj).first()

    if time_tracking_entry:
        entry_data = {
            'id': time_tracking_entry.id,
            'date': time_tracking_entry.date.strftime('%Y-%m-%d'),
            'start_time': time_tracking_entry.start_time.strftime('%H:%M:%S') if time_tracking_entry.start_time else None,
            'end_time': time_tracking_entry.end_time.strftime('%H:%M:%S') if time_tracking_entry.end_time else None,
            'offset': time_tracking_entry.offset,
            'pause_time': time_tracking_entry.pause_time.strftime('%H:%M:%S') if time_tracking_entry.pause_time else None
        }
        return jsonify(entry_data)
    else:
        return jsonify({'message': 'No time tracking entry found for the given date.'}), 404


@app.route('/most_recent_end_time', methods=['GET'])
def most_recent_end_time():
    today = date.today()
    most_recent_task = Task_Item.query.filter_by(date=today)\
        .filter(Task_Item.end_time.isnot(None))\
        .order_by(Task_Item.end_time.desc()).first()
    most_recent_break = BreakTracking.query.filter_by(date=today)\
        .filter(BreakTracking.end_time.isnot(None))\
        .order_by(BreakTracking.end_time.desc()).first()
    today_start_time = TimeTracking.query.filter_by(date=today).first()

    if most_recent_task and most_recent_task.end_time:
        most_recent_end_time = most_recent_task.end_time
    if most_recent_break and most_recent_break.end_time > most_recent_end_time:
        most_recent_end_time = most_recent_break.end_time
    if today_start_time and today_start_time.start_time > most_recent_end_time:
        most_recent_end_time = today_start_time.start_time

    if most_recent_end_time:
        return jsonify({'mostRecentEndTime': most_recent_end_time.strftime('%H:%M')})
    else:
        return jsonify({'mostRecentEndTime': None})
    
@app.route('/get_min_time', methods=['GET'])
def get_min_time():
    today = date.today()
    on_break_time_status = bool(len(TimeTracking.query.filter_by(date=today, start_time=None).all())>0) # returns 0 if the user is currently on a break
    tasks_exist_for_today = bool(len(Task_Item.query.filter_by(date=today).all())>0)
    incomplete_tasks_exist = bool(len(Task_Item.query.filter_by(date=today, end_time=None).all())>0)
    day_started_status = bool(len(TimeTracking.query.filter_by(date=today).all())>0)
    break_completed_status = bool(len(BreakTracking.query.filter_by(date=today).all())>0)

    print("Here")
    print("Day started status :", day_started_status)
    print("On break status :", on_break_time_status)
    print(day_started_status and on_break_time_status)

    if day_started_status and on_break_time_status:
        # If the user is on break, return the minimum time for the day
        break_start_time = TimeTracking.query.filter_by(date=today).first().pause_time.strftime('%H:%M')
        print("Min time for clock :", break_start_time)
        min_time = break_start_time
        print("Min time for clock with break :", min_time)
        return jsonify({'min_time': min_time})
    elif incomplete_tasks_exist:
        # If there are incomplete tasks, return the minimum time for the day
        min_time = Task_Item.query.filter_by(date=today, end_time=None).first().start_time.strftime('%H:%M')
        print("Min time for clock with incomplete task :", min_time)
        return jsonify({'min_time': min_time})
    elif tasks_exist_for_today:
        # If there are no incomplete tasks, return the minimum time for the day
        min_time = Task_Item.query.filter_by(date=today).order_by(desc(Task_Item.end_time)).first().end_time.strftime('%H:%M')
        print("Min time for clock with no incomplete tasks :", min_time)
        return jsonify({'min_time': min_time})
    elif day_started_status and not incomplete_tasks_exist:
        # If there are no incomplete tasks, return the minimum time for the day
        min_time = TimeTracking.query.filter_by(date=today).first().start_time.strftime('%H:%M')
        print("Min time for clock with no tasks yet :", min_time)
        return jsonify({'min_time': min_time})

        
    min_time = '12:00 AM'
    return jsonify({'min_time': min_time})

app.route('/clients', methods=['POST'])
def create_client():
    data = request.get_json()
    client_name = data.get('name')
    
    if not client_name:
        return jsonify({'error': 'Client name is required'}), 400
    
    new_client = Client(name=client_name)
    
    try:
        db.session.add(new_client)
        db.session.commit()
        return jsonify({'id': new_client.id, 'name': new_client.name}), 201
    except Exception as e:
        db.session.rollback()
        return jsonify({'error': str(e)}), 500

@app.route('/summary')
def summary_page():
    clients = Client.query.all()
    return render_template('time_summary.html', clients=clients)
    
@app.route('/api/summary/<string:period>/<int:client_id>', methods=['GET'])
def get_time_summary(period, client_id):
    if period not in ['weekly', 'monthly']:
        return jsonify({'error': 'Invalid period. Use "weekly" or "monthly".'}), 400

    today = datetime.now().date()
    if period == 'weekly':
        start_date = today - timedelta(days=today.weekday())
    else:  # monthly
        start_date = today.replace(day=1)

    summary = db.session.query(
        func.sum(Task_Item.time_spent).label('total_time')
    ).filter(
        Task_Item.client_id == client_id,
        Task_Item.date >= start_date
    ).first()

    return jsonify({
        'client_id': client_id,
        'period': period,
        'total_time': summary.total_time if summary.total_time else 0
    })


# Define the global stop event
stop_event = threading.Event()
server_thread = None

def start_server():
    app.run(port=5000, threaded=True)

def create_window():
    window = webview.create_window(
        'Time Tracker', 
        'http://127.0.0.1:5000',
        width=1200,
        height=800,
        resizable=True,
        min_size=(800, 600)
    )
    return window


admin = Admin(app, name='Admin Panel', template_mode='bootstrap3')

# Add model views to Flask-Admin
admin.add_view(ModelView(Task_Item, db.session))
admin.add_view(ModelView(TimeTracking, db.session))
admin.add_view(ModelView(Client, db.session))
admin.add_view(ModelView(BreakTracking, db.session))

if __name__ == '__main__':
    # Start Flask server in a separate thread
    t = threading.Thread(target=start_server)
    t.daemon = True
    t.start()

    # Create and start webview window
    window = create_window()
    webview.start(debug=DEV_MODE)
