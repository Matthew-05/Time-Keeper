"""Client colour generation and validation shared by models and HTTP routes."""

import colorsys
import random
import re


HEX_COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')
_RANDOM = random.SystemRandom()


def random_client_color():
    """Return a vivid, readable random colour accepted by ``input[type=color]``."""
    hue = _RANDOM.random()
    red, green, blue = colorsys.hls_to_rgb(hue, 0.58, 0.62)
    return '#{:02x}{:02x}{:02x}'.format(
        round(red * 255),
        round(green * 255),
        round(blue * 255),
    )


def normalize_client_color(value):
    """Normalize a valid six-digit hex colour, raising for any other shape."""
    if not isinstance(value, str) or not HEX_COLOR_RE.fullmatch(value.strip()):
        raise ValueError('Color must be a six-digit hex value such as #3057e3')
    return value.strip().lower()
