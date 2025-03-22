from flask import Flask, render_template, request, jsonify, redirect, url_for
from models import db, Client
import threading
import time

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///clients.db'
db.init_app(app)

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

if __name__ == '__main__':
    app.run(debug=True)
