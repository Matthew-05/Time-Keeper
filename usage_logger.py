"""Optional external usage logging configured exclusively through environment."""

from __future__ import annotations

import getpass
import logging
import os

import httpx


logger = logging.getLogger(__name__)
REQUEST_TIMEOUT = httpx.Timeout(connect=3.0, read=5.0, write=5.0, pool=3.0)


def _enabled() -> bool:
    return os.environ.get("TIMEKEEPER_USAGE_LOG_ENABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


class UsageLogger:
    """Send best-effort usage events when explicitly configured."""

    @staticmethod
    def send_log(action_name, details=None):
        if not _enabled():
            return None

        url = os.environ.get("TIMEKEEPER_USAGE_LOG_URL", "").strip()
        authorization = os.environ.get(
            "TIMEKEEPER_USAGE_LOG_AUTHORIZATION", ""
        ).strip()
        application_name = os.environ.get(
            "TIMEKEEPER_USAGE_LOG_APPLICATION_NAME", "Time-Keeper"
        ).strip()
        if not url or not authorization:
            logger.warning(
                "Usage logging is enabled but its URL or authorization value is missing."
            )
            return None

        data = {
            "application_name": application_name or "Time-Keeper",
            "action": action_name,
            "username": getpass.getuser(),
        }
        if details:
            data.update(details)

        try:
            with httpx.Client(timeout=REQUEST_TIMEOUT, follow_redirects=False) as client:
                response = client.post(
                    url,
                    json=data,
                    headers={
                        "Authorization": authorization,
                        "Content-Type": "application/json",
                    },
                )
                response.raise_for_status()
                return response.json() if response.content else None
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("Could not send usage log: %s", exc)
            return None
