import hashlib
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx

import updater


ROOT = Path(__file__).resolve().parents[1]


class UpdaterTests(unittest.TestCase):
    def client(self, handler):
        return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)

    def release(self, version, payload=b"installer", *, prerelease=False, digest=True, sidecar=True):
        installer_name = f"Time-Keeper-Setup-{version}.exe"
        sha = hashlib.sha256(payload).hexdigest()
        assets = [{
            "name": installer_name,
            "browser_download_url": (
                f"{updater.RELEASE_ASSET_PREFIX}v{version}/{installer_name}"
            ),
            "size": len(payload),
            "digest": f"sha256:{sha}" if digest else None,
        }]
        if sidecar:
            checksum = f"{sha}  {installer_name}\n".encode()
            assets.append({
                "name": f"{installer_name}.sha256",
                "browser_download_url": (
                    f"{updater.RELEASE_ASSET_PREFIX}v{version}/{installer_name}.sha256"
                ),
                "size": len(checksum),
            })
        return {
            "tag_name": f"v{version}",
            "draft": False,
            "prerelease": prerelease,
            "html_url": f"https://github.com/Matthew-05/Time-Keeper/releases/tag/v{version}",
            "assets": assets,
        }, sha

    def test_check_selects_highest_stable_release_and_exact_asset(self):
        old, _ = self.release("1.5.0")
        prerelease, _ = self.release("9.0.0", prerelease=True)
        latest, _ = self.release("2.0.0")

        def handler(request):
            self.assertEqual(request.url.path, "/repos/Matthew-05/Time-Keeper/releases")
            return httpx.Response(200, json=[old, prerelease, latest])

        with self.client(handler) as client:
            result = updater.check_for_update("1.2.0", client)
        self.assertEqual(result.latest_version, "2.0.0")
        self.assertEqual(result.installer.name, "Time-Keeper-Setup-2.0.0.exe")

    def test_check_returns_none_when_current_is_latest(self):
        release, _ = self.release("1.2.0")
        with self.client(lambda request: httpx.Response(200, json=[release])) as client:
            self.assertIsNone(updater.check_for_update("1.2.0", client))

    def test_check_rejects_release_without_exact_versioned_installer(self):
        release, _ = self.release("1.3.0")
        release["assets"][0]["name"] = "Time-Keeper-Setup.exe"
        with self.client(lambda request: httpx.Response(200, json=[release])) as client:
            with self.assertRaisesRegex(updater.UpdateError, "expected"):
                updater.check_for_update("1.2.0", client)

    def test_check_requires_digest_or_sidecar(self):
        release, _ = self.release("1.3.0", digest=False, sidecar=False)
        with self.client(lambda request: httpx.Response(200, json=[release])) as client:
            with self.assertRaisesRegex(updater.UpdateError, "no SHA-256"):
                updater.check_for_update("1.2.0", client)

    def test_check_maps_timeout_to_readable_error(self):
        def handler(request):
            raise httpx.ReadTimeout("slow", request=request)

        with self.client(handler) as client:
            with self.assertRaisesRegex(updater.UpdateError, "Timed out"):
                updater.check_for_update("1.2.0", client)

    def test_check_rejects_redirected_release_metadata(self):
        release, _ = self.release("1.3.0")

        def handler(request):
            if request.url.path.endswith("/releases"):
                return httpx.Response(
                    302,
                    headers={"location": "https://api.github.com/redirected-metadata"},
                )
            return httpx.Response(200, json=[release])

        with self.client(handler) as client:
            with self.assertRaisesRegex(updater.UpdateError, "redirected"):
                updater.check_for_update("1.2.0", client)

    def test_check_rejects_asset_from_another_github_repository(self):
        release, _ = self.release("1.3.0")
        release["assets"][0]["browser_download_url"] = (
            "https://github.com/other/project/releases/download/v1.3.0/"
            "Time-Keeper-Setup-1.3.0.exe"
        )
        with self.client(lambda request: httpx.Response(200, json=[release])) as client:
            with self.assertRaisesRegex(updater.UpdateError, "expected"):
                updater.check_for_update("1.2.0", client)

    def test_check_rejects_asset_url_for_wrong_release_tag(self):
        release, _ = self.release("1.3.0")
        release["assets"][0]["browser_download_url"] = (
            f"{updater.RELEASE_ASSET_PREFIX}v9.9.9/Time-Keeper-Setup-1.3.0.exe"
        )
        with self.client(lambda request: httpx.Response(200, json=[release])) as client:
            with self.assertRaisesRegex(updater.UpdateError, "unexpected installer URL"):
                updater.check_for_update("1.2.0", client)

    def test_check_rejects_unreasonably_large_installer(self):
        release, _ = self.release("1.3.0")
        release["assets"][0]["size"] = updater.MAX_INSTALLER_BYTES + 1
        with self.client(lambda request: httpx.Response(200, json=[release])) as client:
            with self.assertRaisesRegex(updater.UpdateError, "unexpectedly large"):
                updater.check_for_update("1.2.0", client)

    def _download_case(self, *, payload=b"verified installer", response_payload=None,
                       content_length=None, sidecar_hash=None, asset_size=None):
        release, sha = self.release("1.3.0", payload, digest=True, sidecar=True)
        installer = updater._asset(release["assets"][0])
        checksum = updater._asset(release["assets"][1])
        if asset_size is not None:
            installer = updater.ReleaseAsset(installer.name, installer.url, asset_size, installer.digest)
        info = updater.UpdateInfo("1.2.0", "1.3.0", release["html_url"], installer, checksum)
        checksum_hash = sidecar_hash or sha
        checksum_body = f"{checksum_hash}  {installer.name}\n".encode()
        # Keep API asset metadata consistent with the test sidecar response.
        info = updater.UpdateInfo(
            info.current_version, info.latest_version, info.release_url, info.installer,
            updater.ReleaseAsset(checksum.name, checksum.url, len(checksum_body), None),
        )
        body = payload if response_payload is None else response_payload

        def handler(request):
            if request.url.path.endswith(".sha256"):
                return httpx.Response(200, content=checksum_body)
            if content_length is False:
                return httpx.Response(200, stream=httpx.ByteStream(body))
            headers = {}
            headers["content-length"] = str(len(body) if content_length is None else content_length)
            return httpx.Response(200, content=body, headers=headers)
        return info, self.client(handler), body

    def test_download_streams_part_then_returns_verified_installer(self):
        info, client, payload = self._download_case()
        progress = []
        with TemporaryDirectory() as directory, client:
            verified = updater.download_update(
                info, directory, lambda received, total: progress.append((received, total)), client
            )
            self.assertEqual(verified.path.read_bytes(), payload)
            self.assertEqual(verified.sha256, hashlib.sha256(payload).hexdigest())
            self.assertFalse(Path(directory, f"{info.installer.name}.part").exists())
        self.assertTrue(progress)
        self.assertEqual(progress[-1], (len(payload), len(payload)))

    def test_download_rejects_hash_mismatch_and_removes_part(self):
        info, client, _ = self._download_case(sidecar_hash="0" * 64)
        with TemporaryDirectory() as directory, client:
            with self.assertRaisesRegex(updater.UpdateError, "disagree"):
                updater.download_update(info, directory, client=client)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_download_rejects_incomplete_body_even_without_content_length(self):
        payload = b"complete payload"
        info, client, _ = self._download_case(
            payload=payload, response_payload=payload[:-3], content_length=False
        )
        with TemporaryDirectory() as directory, client:
            with self.assertRaisesRegex(updater.UpdateError, "incomplete"):
                updater.download_update(info, directory, client=client)
            self.assertFalse(Path(directory, f"{info.installer.name}.part").exists())

    def test_download_rejects_content_length_different_from_asset_size(self):
        info, client, _ = self._download_case(content_length=999)
        with TemporaryDirectory() as directory, client:
            with self.assertRaisesRegex(updater.UpdateError, "Content-Length"):
                updater.download_update(info, directory, client=client)

    def test_sidecar_must_name_exact_installer(self):
        release, sha = self.release("1.3.0", digest=False, sidecar=True)
        installer = updater._asset(release["assets"][0])
        wrong = f"{sha}  Other.exe\n".encode()
        checksum = updater.ReleaseAsset(
            release["assets"][1]["name"], release["assets"][1]["browser_download_url"], len(wrong)
        )
        info = updater.UpdateInfo("1.2.0", "1.3.0", release["html_url"], installer, checksum)

        def handler(request):
            return httpx.Response(200, content=wrong)

        with TemporaryDirectory() as directory, self.client(handler) as client:
            with self.assertRaisesRegex(updater.UpdateError, "does not contain"):
                updater.download_update(info, directory, client=client)

    def test_sidecar_stream_stops_when_response_exceeds_asset_size(self):
        release, _ = self.release("1.3.0", digest=False, sidecar=True)
        installer = updater._asset(release["assets"][0])
        checksum = updater.ReleaseAsset(
            release["assets"][1]["name"],
            release["assets"][1]["browser_download_url"],
            8,
        )
        info = updater.UpdateInfo("1.2.0", "1.3.0", release["html_url"], installer, checksum)

        def handler(request):
            return httpx.Response(200, stream=httpx.ByteStream(b"0" * 128))

        with TemporaryDirectory() as directory, self.client(handler) as client:
            with self.assertRaisesRegex(updater.UpdateError, "exceeded"):
                updater.download_update(info, directory, client=client)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_download_revalidates_trusted_asset_url(self):
        info, client, _ = self._download_case()
        forged = updater.UpdateInfo(
            info.current_version,
            info.latest_version,
            info.release_url,
            updater.ReleaseAsset(
                info.installer.name,
                "https://github.com/other/project/releases/download/v1.3.0/"
                + info.installer.name,
                info.installer.size,
                info.installer.digest,
            ),
            info.checksum,
        )
        with TemporaryDirectory() as directory, client:
            with self.assertRaisesRegex(updater.UpdateError, "trusted release asset path"):
                updater.download_update(forged, directory, client=client)

    def test_download_rejects_redirect_to_untrusted_host(self):
        payload = b"verified installer"
        release, _ = self.release("1.3.0", payload, sidecar=False)
        installer = updater._asset(release["assets"][0])
        info = updater.UpdateInfo(
            "1.2.0", "1.3.0", release["html_url"], installer, None
        )

        def handler(request):
            if request.url.host == "github.com":
                return httpx.Response(
                    302,
                    headers={"location": "https://downloads.example/installer.exe"},
                )
            return httpx.Response(200, content=payload)

        with TemporaryDirectory() as directory, self.client(handler) as client:
            with self.assertRaisesRegex(updater.UpdateError, "untrusted host"):
                updater.download_update(info, directory, client=client)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_launch_uses_argument_list_without_shell(self):
        with TemporaryDirectory() as directory:
            path = Path(directory, "Time-Keeper-Setup-1.3.0.exe")
            path.write_bytes(b"verified")
            with patch("updater.subprocess.Popen") as popen:
                updater.launch_installer(
                    updater.VerifiedInstaller(path, len(b"verified"), hashlib.sha256(b"verified").hexdigest())
                )
            popen.assert_called_once_with([str(path.resolve())], shell=False, close_fds=True)

    def test_launch_rejects_installer_changed_after_verification(self):
        with TemporaryDirectory() as directory:
            path = Path(directory, "Time-Keeper-Setup-1.3.0.exe")
            path.write_bytes(b"verified")
            verified = updater.VerifiedInstaller(
                path, len(b"verified"), hashlib.sha256(b"verified").hexdigest()
            )
            path.write_bytes(b"tampered!")
            with patch("updater.subprocess.Popen") as popen:
                with self.assertRaisesRegex(updater.UpdateError, "changed"):
                    updater.launch_installer(verified)
            popen.assert_not_called()

    def test_packaged_app_checks_for_updates_on_every_start(self):
        main_source = (ROOT / "main.py").read_text(encoding="utf-8")
        self.assertIn("def start_startup_update_check():", main_source)
        self.assertIn("return _start_update_check(startup=True)", main_source)
        self.assertIn("\n    start_startup_update_check()\n", main_source)
        self.assertNotIn("automatic_check_due", main_source)


if __name__ == "__main__":
    unittest.main()
