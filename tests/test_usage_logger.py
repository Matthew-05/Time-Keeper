import os
import unittest
from unittest.mock import MagicMock, patch

from usage_logger import UsageLogger


class UsageLoggerTests(unittest.TestCase):
    def test_disabled_logger_does_not_create_http_client(self):
        with patch.dict(os.environ, {}, clear=True), patch(
            "usage_logger.httpx.Client"
        ) as client:
            self.assertIsNone(UsageLogger.send_log("Program started"))
            client.assert_not_called()

    def test_configured_logger_posts_environment_values(self):
        response = MagicMock()
        response.content = b'{"ok": true}'
        response.json.return_value = {"ok": True}
        client = MagicMock()
        client.__enter__.return_value.post.return_value = response
        environment = {
            "TIMEKEEPER_USAGE_LOG_ENABLED": "1",
            "TIMEKEEPER_USAGE_LOG_URL": "https://example.invalid/usage",
            "TIMEKEEPER_USAGE_LOG_AUTHORIZATION": "Token private-value",
            "TIMEKEEPER_USAGE_LOG_APPLICATION_NAME": "Time-Keeper-Test",
        }

        with patch.dict(os.environ, environment, clear=True), patch(
            "usage_logger.httpx.Client", return_value=client
        ), patch(
            "usage_logger.getpass.getuser", return_value="test-user"
        ):
            result = UsageLogger.send_log("Program started", {"version": "9.9.9"})

        self.assertEqual(result, {"ok": True})
        response.raise_for_status.assert_called_once_with()
        _, kwargs = client.__enter__.return_value.post.call_args
        self.assertEqual(kwargs["headers"]["Authorization"], "Token private-value")
        self.assertEqual(kwargs["json"]["application_name"], "Time-Keeper-Test")
        self.assertEqual(kwargs["json"]["version"], "9.9.9")

    def test_enabled_logger_without_credentials_is_nonfatal(self):
        with patch.dict(
            os.environ, {"TIMEKEEPER_USAGE_LOG_ENABLED": "true"}, clear=True
        ), patch("usage_logger.httpx.Client") as client:
            self.assertIsNone(UsageLogger.send_log("Program started"))
            client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
