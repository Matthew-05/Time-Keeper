"""Windows toast notifications, and the plumbing that makes their buttons work.

Two separate problems live here.

**Showing a toast.** ``winotify`` builds a small PowerShell script and runs it,
which is the only way to raise a real Windows toast from a plain Python process
without an installed AppX identity. It's a hard dependency for the reminder but
a soft one for the app: if it's missing, or we're not on Windows, or PowerShell
refuses, ``send`` returns a reason instead of raising. A silent reminder is a
bug worth logging; a crashed timer thread is worse.

**Getting a button press back.** A toast button can only do one thing: hand a
URI to the shell. It has no way to call back into the process that raised it —
and by the time the user clicks, that process may not even be running. So we
register a ``timekeeper://`` protocol handler under HKCU (no admin needed)
pointing at our own executable, and ``main.py`` forwards any URI it's launched
with into the already-running instance over the local HTTP server. Clicking
*Snooze* therefore costs one short-lived process. That's the price of toast
actions; the alternative is a toast you can only dismiss.

Registration is idempotent and re-run on every start, because the handler
command embeds an absolute path — moving or reinstalling the app, or switching
between running from source and running the build, invalidates it.
"""

import logging
import os
import shutil
import struct
import sys
import zlib

logger = logging.getLogger('timekeeper')

PROTOCOL = 'timekeeper'
APP_ID = 'Time Keeper'

# Where the toast icon is copied to. It has to be a path that still resolves
# after the app exits: toasts linger in the Action Center, and a PyInstaller
# onefile bundle's _MEIPASS directory is deleted on shutdown.
ICON_NAME = 'toast-icon.png'

_icon_path = None

try:
    from winotify import Notification, audio

    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - depends on platform
    Notification = None
    audio = None
    _IMPORT_ERROR = exc


def available():
    """Can we actually raise a toast on this machine?"""
    return Notification is not None and sys.platform == 'win32'


def unavailable_reason():
    """Why not, in words fit for a log line or a dev-mode toast."""
    if sys.platform != 'win32':
        return f'not running on Windows (sys.platform={sys.platform})'
    if Notification is None:
        return f'winotify is not installed ({_IMPORT_ERROR})'
    return None


def _png_chunk(tag, payload):
    """One PNG chunk: length, type, payload, CRC of type+payload."""
    body = tag + payload
    return struct.pack('>I', len(payload)) + body + struct.pack('>I', zlib.crc32(body))


def _encode_png(width, height, rows):
    """Minimal 8-bit RGBA PNG encoder. `rows` is top-to-bottom RGBA bytes.

    Filter type 0 on every scanline — no prediction. The icon is 4KB, so the
    handful of bytes a smarter filter would save aren't worth the code.
    """
    header = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    raw = b''.join(b'\x00' + row for row in rows)
    return (
        b'\x89PNG\r\n\x1a\x0a'
        + _png_chunk(b'IHDR', header)
        + _png_chunk(b'IDAT', zlib.compress(raw, 9))
        + _png_chunk(b'IEND', b'')
    )


def _ico_to_png(path):
    """Convert a .ico to PNG bytes, or return None if we can't.

    Toast images accept PNG, JPEG and SVG — not ICO — so pointing a toast at
    icon.ico gets you a blank space where the logo should be. But icon.ico *is*
    the app's real identity (it's what the exe and the taskbar show), so we take
    its artwork and re-encode rather than shipping a second, different image.

    Only the two uncompressed forms that matter here are handled: a 32-bit DIB
    (what icon.ico actually is) and a PNG-compressed entry (what larger modern
    icons use, where there's nothing to do but pass it through). A palettised
    or 24-bit icon returns None and the caller falls back to icon.png.
    """
    with open(path, 'rb') as fh:
        data = fh.read()

    reserved, kind, count = struct.unpack('<HHH', data[:6])
    if reserved != 0 or kind != 1 or count == 0:
        return None

    entries = []
    for index in range(count):
        offset = 6 + index * 16
        width, height, _, _, _, bpp, size, position = struct.unpack(
            '<BBBBHHII', data[offset:offset + 16]
        )
        # 0 means 256 in the ICO directory — the field is a single byte.
        entries.append((width or 256, height or 256, bpp, size, position))

    # Biggest, then deepest: the toast logo is rendered around 48px, so more
    # pixels is strictly better.
    width, height, bpp, size, position = max(entries, key=lambda e: (e[0] * e[1], e[2]))
    blob = data[position:position + size]

    if blob[:8] == b'\x89PNG\r\n\x1a\x0a':
        return blob

    header_size, dib_width, dib_height, _, dib_bpp, compression = struct.unpack(
        '<IiiHHI', blob[:20]
    )
    if header_size != 40 or dib_bpp != 32 or compression != 0:
        return None

    # An icon DIB stores the colour rows and a 1-bit AND mask stacked, so the
    # recorded height is double the real one. 32-bit icons carry a real alpha
    # channel, which makes the mask redundant — we read the colours and stop.
    height = dib_height // 2
    width = dib_width
    pixels = blob[header_size:header_size + width * height * 4]
    if len(pixels) < width * height * 4:
        return None

    stride = width * 4
    rows = []
    for y in range(height):
        # DIB rows run bottom-up, and each pixel is BGRA rather than RGBA.
        row = bytearray(pixels[(height - 1 - y) * stride:(height - y) * stride])
        row[0::4], row[2::4] = row[2::4], row[0::4]
        rows.append(bytes(row))

    return _encode_png(width, height, rows)


def install_icon(source_dir, user_data_dir):
    """Put a toast-usable copy of the app icon somewhere stable, and remember it.

    "Stable" matters: toasts linger in the Action Center after the app closes,
    and a PyInstaller onefile bundle's _MEIPASS directory is deleted on exit, so
    a toast pointing into it loses its icon the moment you quit.

    Prefers icon.ico — the app's actual icon — converted to PNG, and falls back
    to icon.png if that conversion can't be done. Best-effort throughout: a
    toast with no icon still shows.
    """
    global _icon_path

    target = os.path.join(user_data_dir, ICON_NAME)
    ico = os.path.join(source_dir, 'icon.ico')
    png = os.path.join(source_dir, 'icon.png')

    try:
        encoded = None
        if os.path.exists(ico):
            try:
                encoded = _ico_to_png(ico)
            except (OSError, struct.error, ValueError, zlib.error) as exc:
                logger.warning(f'Could not convert icon.ico for the toast: {exc}')

        # Rewritten on every launch so a new build's icon replaces the old one.
        if encoded:
            with open(target, 'wb') as fh:
                fh.write(encoded)
        elif os.path.exists(png):
            logger.debug('Falling back to icon.png for the toast icon')
            shutil.copyfile(png, target)

        if os.path.exists(target):
            _icon_path = os.path.abspath(target)
    except OSError as exc:
        logger.warning(f'Could not install the toast icon: {exc}')

    return _icon_path


def send(title, message, actions=(), silent=False):
    """Raise a Windows toast. Returns ``(sent, reason)``.

    `actions` is a sequence of ``(label, uri)`` pairs. Windows shows at most
    five buttons and truncates long labels, so keep them short.

    Never raises — the caller is usually a background thread whose death would
    silently stop all future reminders.
    """
    reason = unavailable_reason()
    if reason:
        return False, reason

    try:
        toast = Notification(
            app_id=APP_ID,
            title=title,
            msg=message,
            icon=_icon_path or '',
            duration='short',
        )
        for label, uri in actions:
            toast.add_actions(label=label, launch=uri)

        # Default is no sound at all, which is easy to miss when the window is
        # behind something. `silent` exists for the dev-mode test button.
        if not silent:
            toast.set_audio(audio.Default, loop=False)

        toast.show()
        return True, None
    except Exception as exc:
        logger.error(f'Could not show notification: {exc}')
        return False, str(exc)


# --------------------------------------------------------------------------
# timekeeper:// protocol handler
# --------------------------------------------------------------------------


def _handler_command():
    """The command line Windows should run for a ``timekeeper://`` URI.

    Frozen, that's just our own exe. From source it's the interpreter plus
    ``main.py`` — preferring ``pythonw.exe`` so a snooze click doesn't flash a
    console window across the screen.
    """
    executable = os.path.abspath(sys.executable)

    if getattr(sys, 'frozen', False):
        return f'"{executable}" "%1"'

    windowless = os.path.join(os.path.dirname(executable), 'pythonw.exe')
    if os.path.exists(windowless):
        executable = windowless

    script = os.path.abspath(os.path.join(os.path.dirname(__file__), 'main.py'))
    return f'"{executable}" "{script}" "%1"'


def ensure_protocol_registered():
    """Register (or refresh) the ``timekeeper://`` handler for this user.

    Returns True if the handler is in place. Failure is not fatal: toasts still
    appear, their buttons just do nothing, so this logs and moves on.
    """
    if sys.platform != 'win32':
        return False

    import winreg

    command = _handler_command()
    root = rf'Software\Classes\{PROTOCOL}'

    try:
        # Skip the write when nothing changed — this runs on every launch.
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf'{root}\shell\open\command') as key:
                if winreg.QueryValueEx(key, '')[0] == command:
                    return True
        except FileNotFoundError:
            pass

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, root) as key:
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, 'URL:Time Keeper Protocol')
            # The presence of this value is what marks the key as a URL scheme;
            # its content is ignored.
            winreg.SetValueEx(key, 'URL Protocol', 0, winreg.REG_SZ, '')

        if _icon_path:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf'{root}\DefaultIcon') as key:
                winreg.SetValueEx(key, '', 0, winreg.REG_SZ, f'{_icon_path},0')

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf'{root}\shell\open\command') as key:
            winreg.SetValueEx(key, '', 0, winreg.REG_SZ, command)

        logger.debug(f'Registered {PROTOCOL}:// handler -> {command}')
        return True
    except OSError as exc:
        logger.warning(f'Could not register the {PROTOCOL}:// handler: {exc}')
        return False


def parse_action(uri):
    """Pull the action name out of a ``timekeeper://snooze`` style URI.

    Returns the lowercased action, or None if this isn't one of ours. Windows
    hands the URI over verbatim from the toast, so it can only ever be a string
    we put there ourselves — but it arrives via the command line, so it's
    treated as untrusted input all the same.
    """
    if not isinstance(uri, str):
        return None

    prefix = f'{PROTOCOL}://'
    lowered = uri.strip().lower()
    if not lowered.startswith(prefix):
        return None

    # Strip the scheme, then any trailing slash or query Windows tacked on.
    action = lowered[len(prefix):].split('?', 1)[0].split('/', 1)[0].strip()
    return action or None
