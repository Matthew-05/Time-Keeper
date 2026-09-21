"""Reaching the running Time Keeper from a second, short-lived process.

Two things arrive this way. Toast buttons launch a ``timekeeper://`` URI, and
Windows answers that by starting a *new* copy of the app (see
``notifications.py``). And a second launch — someone double-clicking the icon
again — should raise the window that's already open rather than put another one
beside it. Either copy's only job is to tell the copy the user is actually
looking at what happened, and then get out of the way.

The server picks a free port at random on every launch, so the port has to be
written down somewhere the second process can find it. Hence a one-line file
next to the database. It's deliberately dumb: no lock, no PID, no handshake. A
stale port from a crashed run just means the forward fails and the click is
ignored, which is the same outcome as the app not running at all.

That file can't stop two copies starting in the same instant — both read no
port and both go ahead — so the real gate is a named mutex the kernel owns
(``claim_single_instance``). The port file is how the loser finds the winner.

Nothing here may import Flask, SQLAlchemy or webview — it runs before those are
loaded, and the whole point is to exit in well under a second.
"""

import ctypes
import logging
import os
import sys
from pathlib import Path

import httpx

logger = logging.getLogger('timekeeper')

USER_DATA_DIR = os.path.join(Path.home(), 'AppData', 'Local', 'TimeKeeper')
PORT_FILE = os.path.join(USER_DATA_DIR, 'server-port')

# Long enough for a local Flask round trip, short enough that a stale port file
# doesn't leave an invisible process hanging around.
FORWARD_TIMEOUT = 3.0

# `Local\` scopes the lock to this login session, which is the only place a
# second launch of a desktop app can happen. The handle is deliberately never
# closed: it has to outlive this function, and the kernel releases it when the
# process exits — including when it crashes.
_SINGLE_INSTANCE_MUTEX = 'Local\\TimeKeeper'
_ERROR_ALREADY_EXISTS = 183


def claim_single_instance():
    """Claim the one-instance lock. False if another copy already holds it.

    The port file is published too late to gate this: a double-click races two
    copies past a missing file and both start. A named mutex is created once by
    the kernel, so exactly one process can be told that it created it.
    """
    if sys.platform != 'win32':
        return True

    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.CreateMutexW.argtypes = (
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_wchar_p,
    )
    kernel32.CreateMutexW.restype = ctypes.c_void_p

    ctypes.set_last_error(0)
    handle = kernel32.CreateMutexW(None, False, _SINGLE_INSTANCE_MUTEX)
    if not handle:
        # Couldn't create it at all — a lock failure must not stop the app.
        return True

    return ctypes.get_last_error() != _ERROR_ALREADY_EXISTS


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


def _allow_foreground_change():
    """Let the instance we're about to reach take the foreground.

    Windows only lets the foreground process move focus, which a background
    instance isn't. This process *was* just launched by the user — a double
    click, or a toast button — so it can hand that right over. The grant lasts
    as long as this process lives, which is why the POST below stays
    synchronous: the other copy has to be allowed while it calls
    ``SetForegroundWindow``.
    """
    if sys.platform != 'win32':
        return

    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL('user32', use_last_error=True)
        user32.AllowSetForegroundWindow.argtypes = (wintypes.DWORD,)
        user32.AllowSetForegroundWindow.restype = wintypes.BOOL
        user32.AllowSetForegroundWindow(0xFFFFFFFF)  # ASFW_ANY
    except Exception as exc:
        logger.debug(f'Could not hand over the foreground right: {exc}')


def _post(path, payload=None):
    """POST to the running instance. None if there isn't a usable one."""
    port = read_port()
    if port is None:
        return None

    _allow_foreground_change()
    try:
        return httpx.post(
            f'http://127.0.0.1:{port}{path}',
            json=payload,
            timeout=FORWARD_TIMEOUT,
        )
    except Exception as exc:
        logger.debug(f'Could not reach the running instance at {path}: {exc}')
        return None


def forward_uri(uri):
    """Hand `uri` to the running instance. True if it accepted it.

    Called from a process that exists only to do this, so every failure mode —
    no port file, nothing listening, an error response — is just "no".
    """
    response = _post('/api/reminder/action', {'uri': uri})
    return response is not None and response.status_code == 200


def focus_running_instance():
    """Ask the running instance to raise its window. True if it answered.

    A second launch calls this before doing any work of its own and exits on
    yes. The response body is ignored: an answer at all means another copy is
    alive and owns the port file, so this launch should defer to it even if its
    window hasn't appeared yet.
    """
    response = _post('/api/window/focus')
    return response is not None and response.status_code == 200
