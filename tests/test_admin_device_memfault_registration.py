"""Creating a device in AWS also registers it in Memfault, but never depends on it.

/admin/devices/create is the one action that mints Sidewalk credentials, so it
is also where the matching Memfault device is created. The ordering matters: a
wireless device that exists in AWS but not in this app's database has to be
found and cleaned up by hand, so Memfault is contacted only after the local
record is committed, and any Memfault failure is a warning rather than an
error.
"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# See the note in test_admin_device_create.py: config.py reads the environment
# once at import time and app.py may already be imported by another test
# module, so DemoConfig is patched per-test instead of relying on this
# environment setup winning the race.
_TEMP_DIR = tempfile.mkdtemp()
os.environ.setdefault("DATABASE_PATH", str(Path(_TEMP_DIR) / "demo.db"))
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ.setdefault("ADMIN_PASSWORD", "admin-password")
os.environ.setdefault("FLASK_SECRET_KEY", "test-secret")

import app as app_module  # noqa: E402  (import must follow the environment setup)

SMSN = "B" * 64
WIRELESS_DEVICE_JSON = {"Sidewalk": {"SidewalkManufacturingSn": SMSN}}


class CreateDeviceMemfaultRegistrationTests(unittest.TestCase):
    def setUp(self) -> None:
        app_module.app.config["TESTING"] = True
        self._counter = 0

    def _admin_client(self):
        client = app_module.app.test_client()
        response = client.post(
            "/login",
            data={"email": "admin@example.com", "password": "admin-password"},
        )
        self.assertIn(response.status_code, (302, 303))
        return client

    def _post_create(self, admin, ensure_device_for, *, enabled=True, auto_create=True):
        self._counter += 1
        wireless_id = f"wid-memfault-{self._counter}"

        def fake_create_wireless_device(**kwargs):
            return {"id": wireless_id, "arn": "arn:aws:iotwireless:x", "name": kwargs["name"]}

        def fake_refresh(**kwargs):
            return WIRELESS_DEVICE_JSON, {}, {}

        with patch.object(app_module.DemoConfig, "MEMFAULT_ENABLED", enabled), patch.object(
            app_module.DemoConfig, "MEMFAULT_AUTO_CREATE_DEVICES", auto_create
        ), patch.object(
            app_module.cloud_service, "create_wireless_device", side_effect=fake_create_wireless_device
        ), patch.object(
            app_module.cloud_service, "refresh_device_artifacts", side_effect=fake_refresh
        ), patch.object(
            app_module.memfault_service, "ensure_device_for", side_effect=ensure_device_for
        ) as ensure:
            response = admin.post(
                "/admin/devices/create",
                data={
                    "name": f"Memfault Device {self._counter}",
                    "destination_name": "DEST",
                    "device_profile_id": "profile-1",
                    "uplink_topic": "test/topic",
                },
                follow_redirects=False,
            )
        return response, ensure, wireless_id

    def test_created_device_is_registered_in_memfault_under_its_smsn(self) -> None:
        admin = self._admin_client()
        captured = {}

        def ensure_device_for(device):
            captured.update(device)
            return {"ok": True, "created": True, "existed": False, "deviceSerial": SMSN}

        response, ensure, wireless_id = self._post_create(admin, ensure_device_for)

        self.assertIn(response.status_code, (302, 303))
        ensure.assert_called_once()
        self.assertEqual(captured.get("wireless_device_id"), wireless_id)
        # The artifacts just fetched from AWS carry the SMSN, so the Memfault
        # serial resolves to it rather than to the wireless device id.
        self.assertEqual(captured.get("wireless_device_json"), WIRELESS_DEVICE_JSON)

    def test_memfault_failure_does_not_lose_the_device(self) -> None:
        admin = self._admin_client()

        def ensure_device_for(device):
            return {"ok": False, "error": "HTTP 503: upstream down"}

        response, _ensure, wireless_id = self._post_create(admin, ensure_device_for)

        self.assertIn(response.status_code, (302, 303))
        self.assertIsNotNone(
            app_module.store.device_by_wireless_id_full(wireless_id),
            "the AWS device was created, so the local record must survive a Memfault outage",
        )

    def test_memfault_exception_does_not_lose_the_device(self) -> None:
        admin = self._admin_client()

        def ensure_device_for(device):
            raise RuntimeError("unexpected client error")

        response, _ensure, wireless_id = self._post_create(admin, ensure_device_for)

        self.assertIn(response.status_code, (302, 303))
        self.assertIsNotNone(
            app_module.store.device_by_wireless_id_full(wireless_id),
            "an unexpected Memfault error must not roll back the local record",
        )

    def test_no_memfault_call_when_the_gateway_is_disabled(self) -> None:
        admin = self._admin_client()
        _response, ensure, _wireless_id = self._post_create(
            admin, lambda device: {"ok": True}, enabled=False
        )
        ensure.assert_not_called()

    def test_no_memfault_call_when_auto_create_is_off(self) -> None:
        admin = self._admin_client()
        _response, ensure, _wireless_id = self._post_create(
            admin, lambda device: {"ok": True}, auto_create=False
        )
        ensure.assert_not_called()


if __name__ == "__main__":
    unittest.main()
