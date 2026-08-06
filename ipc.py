"""Reaching the running Time Keeper from a second, short-lived process.

Toast buttons launch a ``timekeeper://`` URI, and Windows answers that by
starting a *new* copy of the app (see ``notifications.py``). That copy's only
job is to tell the copy the user is actually looking at what was clicked, and
then get out of the way.

The server picks a free port at random on every launch, so the port has to be
written down somewhere the second process can find it. Hence a one-line file
next to the database. It's deliberately dumb: no lock, no PID, no handshake. A
stale port from a crashed run just means the forward fails and the click is
ignored, which is the same outcome as the app not running at all.

Nothing here may import Flask, SQLAlchemy or webview — it runs before those are
loaded, and the whole point is to exit in well under a second.
"""

import logging
import os
from pathlib import Path

import httpx

logger = logging.getLogger('timekeeper')

USER_DATA_DIR = os.path.join(Path.home(), 'AppData', 'Local', 'TimeKeeper')
PORT_FILE = os.path.join(USER_DATA_DIR, 'server-port')

# Long enough for a local Flask round trip, short enough that a stale port file
# doesn't leave an invisible process hanging around.
FORWARD_TIMEOUT = 3.0


def publish_port(port):
    """Record the port the server is listening on."""
    try:
        os.makedirs(USER_DATA_DIR, exist_ok=True)
        with open(PORT_FILE, 'w', encoding='utf-8') as fh:
            fh.write(str(int(port)))
    except (OSError, TypeError, ValueError) as exc:
        logger.warning(f'Could not publish the server port: {exc}')


def clear_port():
    """Remove the port file on a clean shutdown."""
    try:
        os.unlink(PORT_FILE)
    except OSError:
        pass


def read_port():
    """The last published port, or None if there isn't a usable one."""
    try:
        with open(PORT_FILE, 'r', encoding='utf-8') as fh:
            port = int(fh.read().strip())
    except (OSError, ValueError):
        return None

    return port if 1 <= port <= 65535 else None


def forward_uri(uri):
    """Hand `uri` to the running instance. True if it accepted it.

    Called from a process that exists only to do this, so every failure mode —
    no port file, nothing listening, an error response — is just "no".
    """
    port = read_port()
    if port is None:
        return False

    try:
        response = httpx.post(
            f'http://127.0.0.1:{port}/api/reminder/action',
            json={'uri': uri},
            timeout=FORWARD_TIMEOUT,
        )
        return response.status_code == 200
    except Exception as exc:
        logger.debug(f'Could not forward {uri}: {exc}')
        return False
