"""Regression test for the SIDEWALK_LOCATION_DESTINATION_NAME KeyError bug.

/admin/devices/create used to read app.config["SIDEWALK_LOCATION_DESTINATION_NAME"],
a key app.config never receives, so the AWS create-device flow always raised
KeyError, got swallowed by a broad except, and surfaced as a misleading flash
message. The fix reads DemoConfig.SIDEWALK_LOCATION_DESTINATION_NAME instead.
"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# config.py only reads the environment once, at import time, and app.py may
# already be imported (and cached) by another test module by the time this
# one runs (or vice versa: this module may be the one every other test module
# ends up sharing app_module.store with). So: do not clean up this temp dir
# once created, since app_module.store may still be pointed at it long after
# this module's own tests finish, and DemoConfig is patched directly in the
# tests below instead of relying on which module happened to set the
# environment first.
_TEMP_DIR = tempfile.mkdtemp()
os.environ.setdefault("DATABASE_PATH", str(Path(_TEMP_DIR) / "demo.db"))
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ.setdefault("ADMIN_PASSWORD", "admin-password")
os.environ.setdefault("FLASK_SECRET_KEY", "test-secret")

import app as app_module  # noqa: E402  (import must follow the environment setup)


class CreateDeviceConfigBugTests(unittest.TestCase):
    def setUp(self) -> None:
        app_module.app.config["TESTING"] = True

    def _admin_client(self):
        client = app_module.app.test_client()
        response = client.post(
            "/login",
            data={"email": "admin@example.com", "password": "admin-password"},
        )
        self.assertIn(response.status_code, (302, 303))
        return client

    def test_create_device_reads_location_destination_from_democonfig(self) -> None:
        admin = self._admin_client()
        captured = {}

        def fake_create_wireless_device(**kwargs):
            captured.update(kwargs)
            return {"id": "wid-new", "arn": "arn:aws:iotwireless:x", "name": kwargs["name"]}

        def fake_refresh(**kwargs):
            return {}, {}, {}

        with patch.object(
            app_module.DemoConfig, "SIDEWALK_LOCATION_DESTINATION_NAME", "location-dest"
        ), patch.object(
            app_module.cloud_service, "create_wireless_device", side_effect=fake_create_wireless_device
        ), patch.object(app_module.cloud_service, "refresh_device_artifacts", side_effect=fake_refresh):
            response = admin.post(
                "/admin/devices/create",
                data={
                    "name": "Regression Device",
                    "destination_name": "DEST",
                    "device_profile_id": "profile-1",
                    "uplink_topic": "test/topic",
                },
                follow_redirects=False,
            )

        # Before the fix, app.config["SIDEWALK_LOCATION_DESTINATION_NAME"] raised
        # a KeyError before create_wireless_device was ever called, so this dict
        # would be empty and the request would still redirect (error swallowed).
        self.assertIn(response.status_code, (302, 303))
        self.assertEqual(captured.get("location_destination_name"), "location-dest")
        self.assertEqual(captured.get("destination_name"), "DEST")

    def test_falls_back_to_destination_name_when_location_destination_unset(self) -> None:
        admin = self._admin_client()
        captured = {}

        def fake_create_wireless_device(**kwargs):
            captured.update(kwargs)
            return {"id": "wid-new-2", "arn": "arn:aws:iotwireless:y", "name": kwargs["name"]}

        def fake_refresh(**kwargs):
            return {}, {}, {}

        with patch.object(
            app_module.DemoConfig, "SIDEWALK_LOCATION_DESTINATION_NAME", ""
        ), patch.object(
            app_module.cloud_service, "create_wireless_device", side_effect=fake_create_wireless_device
        ), patch.object(app_module.cloud_service, "refresh_device_artifacts", side_effect=fake_refresh):
            admin.post(
                "/admin/devices/create",
                data={
                    "name": "Fallback Device",
                    "destination_name": "FALLBACK-DEST",
                    "device_profile_id": "profile-1",
                    "uplink_topic": "test/topic",
                },
                follow_redirects=False,
            )

        self.assertEqual(captured.get("location_destination_name"), "FALLBACK-DEST")


if __name__ == "__main__":
    unittest.main()
