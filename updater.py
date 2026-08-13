"""Secure GitHub Releases update discovery and installer download.

This module deliberately knows nothing about Flask or pywebview.  It discovers
release metadata, downloads into a temporary ``.part`` file, and returns an
installer path only after both its size and SHA-256 have been verified.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from urllib.parse import urlparse
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import httpx
from packaging.version import InvalidVersion, Version


REPOSITORY = "Matthew-05/Time-Keeper"
RELEASES_URL = f"https://api.github.com/repos/{REPOSITORY}/releases"
RELEASE_ASSET_PREFIX = f"https://github.com/{REPOSITORY}/releases/download/"
RELEASE_PAGE_PREFIX = f"https://github.com/{REPOSITORY}/releases/"
USER_AGENT = "Time-Keeper-Updater"
CHECK_INTERVAL = timedelta(days=1)
TIMEOUT = httpx.Timeout(connect=5.0, read=30.0, write=15.0, pool=5.0)
MAX_SIDECAR_BYTES = 4096
MAX_INSTALLER_BYTES = 512 * 1024 * 1024
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


class UpdateError(RuntimeError):
    """An update could not be discovered, verified, or started safely."""


@dataclass(frozen=True)
class ReleaseAsset:
    name: str
    url: str
    size: int
    digest: str | None = None


@dataclass(frozen=True)
class UpdateInfo:
    current_version: str
    latest_version: str
    release_url: str
    installer: ReleaseAsset
    checksum: ReleaseAsset | None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class VerifiedInstaller:
    path: Path
    size: int
    sha256: str


def _headers(current_version: str) -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": f"{USER_AGENT}/{current_version}",
    }


def _request_error(exc: Exception, action: str) -> UpdateError:
    if isinstance(exc, httpx.TimeoutException):
        return UpdateError(f"Timed out while {action}.")
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status == 403 and exc.response.headers.get("x-ratelimit-remaining") == "0":
            return UpdateError("GitHub's update-check rate limit was reached. Try again later.")
        return UpdateError(f"GitHub returned HTTP {status} while {action}.")
    return UpdateError(f"Could not {action}: {exc}")


def _asset(raw: dict) -> ReleaseAsset | None:
    try:
        name = str(raw["name"])
        url = str(raw["browser_download_url"])
        size = int(raw["size"])
    except (KeyError, TypeError, ValueError):
        return None
    if not name or not url.startswith(RELEASE_ASSET_PREFIX) or size <= 0:
        return None
    digest = raw.get("digest")
    return ReleaseAsset(name, url, size, str(digest) if digest else None)


def _expected_asset_url(version: str, name: str) -> str:
    return f"{RELEASE_ASSET_PREFIX}v{version}/{name}"


def _validate_asset_response(response: httpx.Response) -> None:
    """Allow GitHub asset redirects, but never an arbitrary redirect host."""
    for hop in [*response.history, response]:
        parsed = urlparse(str(hop.url))
        host = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not (
            host == "github.com" or host.endswith(".githubusercontent.com")
        ):
            raise UpdateError("GitHub redirected a release asset to an untrusted host.")


def check_for_update(current_version: str, client: httpx.Client | None = None) -> UpdateInfo | None:
    """Return the newest stable release when it is newer than ``current_version``."""
    try:
        current = Version(current_version)
    except InvalidVersion as exc:
        raise UpdateError(f"The installed version {current_version!r} is invalid.") from exc

    owns_client = client is None
    # Release metadata comes from one hard-coded API endpoint and must not be
    # redirected. Redirects are enabled only by the asset-download client.
    client = client or httpx.Client(timeout=TIMEOUT, follow_redirects=False)
    try:
        try:
            response = client.get(
                RELEASES_URL,
                params={"per_page": 30},
                headers=_headers(current_version),
            )
            if response.history:
                raise UpdateError("GitHub redirected the trusted release metadata request.")
            response.raise_for_status()
            releases = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise _request_error(exc, "checking for updates") from exc

        if not isinstance(releases, list):
            raise UpdateError("GitHub returned an unexpected release response.")

        candidates: list[tuple[Version, dict]] = []
        for release in releases:
            if not isinstance(release, dict) or release.get("draft") or release.get("prerelease"):
                continue
            tag = str(release.get("tag_name", "")).removeprefix("v")
            try:
                version = Version(tag)
            except InvalidVersion:
                continue
            if version.is_prerelease or version.is_devrelease:
                continue
            candidates.append((version, release))

        if not candidates:
            raise UpdateError("No stable Time Keeper release was found on GitHub.")
        latest, release = max(candidates, key=lambda item: item[0])
        if latest <= current:
            return None

        version_text = str(latest)
        installer_name = f"Time-Keeper-Setup-{version_text}.exe"
        checksum_name = f"{installer_name}.sha256"
        assets = [_asset(item) for item in release.get("assets", [])]
        assets = [item for item in assets if item is not None]
        installer = next((item for item in assets if item.name == installer_name), None)
        checksum = next((item for item in assets if item.name == checksum_name), None)
        if installer is None:
            raise UpdateError(
                f"Release v{version_text} does not include the expected {installer_name} asset."
            )
        if installer.url != _expected_asset_url(version_text, installer_name):
            raise UpdateError(f"Release v{version_text} has an unexpected installer URL.")
        if installer.size > MAX_INSTALLER_BYTES:
            raise UpdateError(f"Release v{version_text} has an unexpectedly large installer.")
        if checksum is not None and checksum.url != _expected_asset_url(
            version_text, checksum_name
        ):
            raise UpdateError(f"Release v{version_text} has an unexpected checksum URL.")
        if not _github_digest(installer.digest) and checksum is None:
            raise UpdateError(
                f"Release v{version_text} has no SHA-256 digest or {checksum_name} sidecar."
            )
        release_url = str(release.get("html_url") or "")
        if not release_url.startswith(RELEASE_PAGE_PREFIX):
            release_url = RELEASE_PAGE_PREFIX.removesuffix("/")
        return UpdateInfo(
            current_version=current_version,
            latest_version=version_text,
            release_url=release_url,
            installer=installer,
            checksum=checksum,
        )
    finally:
        if owns_client:
            client.close()


def _github_digest(value: str | None) -> str | None:
    if not value or not value.lower().startswith("sha256:"):
        return None
    digest = value.split(":", 1)[1].strip().lower()
    return digest if _SHA256_RE.fullmatch(digest) else None


def _sidecar_digest(text: str, installer_name: str) -> str:
    for raw_line in text.splitlines():
        parts = raw_line.strip().split()
        if len(parts) < 2:
            continue
        digest = parts[0].lower()
        filename = parts[-1].lstrip("*")
        if _SHA256_RE.fullmatch(digest) and filename == installer_name:
            return digest
    raise UpdateError(f"Checksum sidecar does not contain an entry for {installer_name}.")


def _download_sidecar(asset: ReleaseAsset, current_version: str, client: httpx.Client) -> str:
    if asset.size > MAX_SIDECAR_BYTES:
        raise UpdateError("Checksum sidecar is unexpectedly large.")
    try:
        content = bytearray()
        with client.stream("GET", asset.url, headers=_headers(current_version)) as response:
            response.raise_for_status()
            _validate_asset_response(response)
            content_length = response.headers.get("content-length")
            if content_length is not None:
                try:
                    header_size = int(content_length)
                except ValueError as exc:
                    raise UpdateError("Checksum response had an invalid Content-Length.") from exc
                if header_size != asset.size:
                    raise UpdateError(
                        "Checksum Content-Length did not match GitHub's asset metadata."
                    )
            for chunk in response.iter_bytes(1024):
                content.extend(chunk)
                if len(content) > asset.size or len(content) > MAX_SIDECAR_BYTES:
                    raise UpdateError("Checksum response exceeded GitHub's asset metadata.")
    except httpx.HTTPError as exc:
        raise _request_error(exc, "downloading the checksum") from exc
    if len(content) != asset.size:
        raise UpdateError("Checksum sidecar size did not match GitHub's asset metadata.")
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise UpdateError("Checksum sidecar was not valid UTF-8 text.") from exc


def download_update(
    update: UpdateInfo,
    destination_dir: str | os.PathLike,
    progress: Callable[[int, int], None] | None = None,
    client: httpx.Client | None = None,
) -> VerifiedInstaller:
    """Stream and verify an update, returning only the completed installer path."""
    expected_installer_name = f"Time-Keeper-Setup-{update.latest_version}.exe"
    if (
        update.installer.name != expected_installer_name
        or update.installer.url
        != _expected_asset_url(update.latest_version, expected_installer_name)
    ):
        raise UpdateError("Refusing to download an installer outside the trusted release asset path.")
    if update.installer.size > MAX_INSTALLER_BYTES:
        raise UpdateError("Refusing to download an unexpectedly large installer.")
    if update.checksum is not None and (
        update.checksum.name != f"{expected_installer_name}.sha256"
        or update.checksum.url
        != _expected_asset_url(update.latest_version, f"{expected_installer_name}.sha256")
    ):
        raise UpdateError("Refusing to download a checksum outside the trusted release asset path.")

    expected = _github_digest(update.installer.digest)
    owns_client = client is None
    client = client or httpx.Client(timeout=TIMEOUT, follow_redirects=True)
    destination = Path(destination_dir)
    destination.mkdir(parents=True, exist_ok=True)
    final_path = destination / update.installer.name
    part_path = None
    try:
        if update.checksum is not None:
            sidecar = _sidecar_digest(
                _download_sidecar(update.checksum, update.current_version, client),
                update.installer.name,
            )
            if expected is not None and sidecar != expected:
                raise UpdateError("GitHub's asset digest and checksum sidecar disagree.")
            expected = sidecar
        if expected is None:
            raise UpdateError("The installer has no usable SHA-256 verification metadata.")

        digest = hashlib.sha256()
        downloaded = 0
        try:
            with client.stream(
                "GET", update.installer.url, headers=_headers(update.current_version)
            ) as response:
                response.raise_for_status()
                _validate_asset_response(response)
                content_length = response.headers.get("content-length")
                if content_length is not None:
                    try:
                        header_size = int(content_length)
                    except ValueError as exc:
                        raise UpdateError("Installer response had an invalid Content-Length.") from exc
                    if header_size != update.installer.size:
                        raise UpdateError("Installer Content-Length did not match GitHub's asset size.")
                handle, temp_name = tempfile.mkstemp(
                    prefix=f".{update.installer.name}.",
                    suffix=".part",
                    dir=destination,
                )
                part_path = Path(temp_name)
                with os.fdopen(handle, "wb") as output:
                    for chunk in response.iter_bytes(128 * 1024):
                        if not chunk:
                            continue
                        downloaded += len(chunk)
                        if downloaded > update.installer.size:
                            raise UpdateError("Installer exceeded GitHub's advertised asset size.")
                        output.write(chunk)
                        digest.update(chunk)
                        if progress:
                            progress(downloaded, update.installer.size)
                    output.flush()
                    os.fsync(output.fileno())
        except httpx.HTTPError as exc:
            raise _request_error(exc, "downloading the installer") from exc

        if downloaded != update.installer.size:
            raise UpdateError(
                f"Installer download was incomplete ({downloaded} of {update.installer.size} bytes)."
            )
        if digest.hexdigest().lower() != expected:
            raise UpdateError("Installer SHA-256 verification failed; it will not be opened.")
        os.replace(part_path, final_path)
        return VerifiedInstaller(final_path, downloaded, expected)
    except BaseException:
        if part_path is not None:
            part_path.unlink(missing_ok=True)
        raise
    finally:
        if owns_client:
            client.close()


def launch_installer(verified: VerifiedInstaller) -> subprocess.Popen:
    """Re-verify and start an Inno Setup executable without shell parsing."""
    installer = Path(verified.path).resolve(strict=True)
    if installer.suffix.lower() != ".exe" or installer.name.endswith(".part"):
        raise UpdateError("Refusing to launch a non-installer file.")
    if installer.stat().st_size != verified.size:
        raise UpdateError("Verified installer size changed before launch.")
    digest = hashlib.sha256()
    with installer.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest().lower() != verified.sha256:
        raise UpdateError("Verified installer changed before launch.")
    return subprocess.Popen([str(installer)], shell=False, close_fds=True)


def automatic_check_due(state_path: str | os.PathLike, now: datetime | None = None) -> bool:
    """Return whether the persisted successful/attempted check is at least one day old."""
    now = now or datetime.now(timezone.utc)
    try:
        data = json.loads(Path(state_path).read_text(encoding="utf-8"))
        checked = datetime.fromisoformat(data["last_checked_at"])
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
        return now - checked.astimezone(timezone.utc) >= CHECK_INTERVAL
    except (FileNotFoundError, OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
        return True


def record_automatic_check(state_path: str | os.PathLike, now: datetime | None = None) -> None:
    """Atomically persist an automatic-check attempt to prevent startup request storms."""
    now = now or datetime.now(timezone.utc)
    path = Path(state_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=".update-state-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as output:
            json.dump({"last_checked_at": now.astimezone(timezone.utc).isoformat()}, output)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise
