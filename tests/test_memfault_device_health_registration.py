"""A device that has never sent a chunk is not a Memfault error.

Reported from the live demo as a red panel reading "Could not read this device
from Memfault: HTTP 404" for Sidewalk_Devkit_BLE_20260908, a device whose
Sidewalk credentials existed in AWS but which had never sent a Memfault chunk,
and which predated device registration at create time. Memfault answers 404
for a serial it has never seen, which is the normal state for a blank device,
not a failure.

So 404 is reported as registered=False rather than an error, and the read path
registers the device on the spot so devices created before this existed heal
themselves instead of needing an admin to re-create them.
"""

import unittest
from unittest.mock import Mock, patch

from memfault import MemfaultService


class _Config:
    MEMFAULT_ENABLED = True
    MEMFAULT_AUTO_CREATE_DEVICES = True
    MEMFAULT_PROJECT_KEY = "project-key"
    MEMFAULT_ORG_SLUG = "org"
    MEMFAULT_PROJECT_SLUG = "proj"
    MEMFAULT_ORG_AUTH_TOKEN = "token"
    MEMFAULT_CHUNKS_BASE_URL = "https://chunks.memfault.com"
    MEMFAULT_API_BASE_URL = "https://api.memfault.com"
    MEMFAULT_DEVICE_SERIAL_SOURCE = "smsn"
    MEMFAULT_HTTP_TIMEOUT_SECS = 10
    MEMFAULT_HARDWARE_VERSION = "sidewalk_devkit_nrf54l15"
    MEMFAULT_COHORT = ""


SMSN = "C" * 64
DEVICE = {
    "name": "Sidewalk_Devkit_BLE_20260908",
    "wireless_device_id": "wd-9",
    "wireless_device_json": {"Sidewalk": {"SidewalkManufacturingSn": SMSN}},
    "provisioning_json": None,
}


def _service(**overrides):
    config = type("Config", (_Config,), overrides)
    store = Mock()
    store.get_memfault_device_health.return_value = None
    return MemfaultService(config, store, Mock())


def _response(status_code, payload=None):
    response = Mock()
    response.status_code = status_code
    response.ok = status_code < 400
    response.text = ""
    response.json.return_value = payload if payload is not None else {"data": {}}
    return response


def _device_detail(**fields):
    return {"data": {"device_serial": SMSN, **fields}}


class DeviceHealthRegistrationTests(unittest.TestCase):
    def test_missing_device_is_registered_then_re_read(self) -> None:
        # 404 on the first detail read, then the device exists after the POST.
        get_responses = [
            _response(404),  # device detail
            _response(200, {"data": []}),  # reboots
            _response(200, _device_detail(last_seen=None)),  # detail after create
            _response(200, {"data": []}),  # reboots after create
        ]
        service = _service()
        with patch("memfault.requests.get", side_effect=get_responses), patch(
            "memfault.requests.post", return_value=_response(200)
        ) as post:
            result = service.device_health(DEVICE)

        post.assert_called_once()
        self.assertEqual(post.call_args[1]["json"]["device_serial"], SMSN)
        self.assertTrue(result["registered"], "the re-read must see the device it just created")
        self.assertIsNone(result.get("error"), "a blank device is not an error")

    def test_404_is_not_surfaced_as_an_error_string(self) -> None:
        """The reported bug: HTTP 404 reached the dashboard as a failure."""
        service = _service(MEMFAULT_AUTO_CREATE_DEVICES=False)
        with patch("memfault.requests.get", return_value=_response(404)), patch(
            "memfault.requests.post"
        ) as post:
            result = service.device_health(DEVICE)

        self.assertFalse(result["registered"])
        self.assertIsNone(result.get("error"))
        post.assert_not_called()

    def test_failed_registration_is_reported_separately_from_a_read_error(self) -> None:
        service = _service()
        with patch("memfault.requests.get", return_value=_response(404)), patch(
            "memfault.requests.post", return_value=_response(403)
        ):
            result = service.device_health(DEVICE)

        self.assertFalse(result["registered"])
        self.assertIn("403", result["registrationError"])
        # Still not a read error: the read worked, it said "no such device".
        self.assertIsNone(result.get("error"))

    def test_a_real_read_failure_does_not_trigger_registration(self) -> None:
        """A 500 means Memfault is unwell, not that the device is missing."""
        service = _service()
        with patch("memfault.requests.get", return_value=_response(500)), patch(
            "memfault.requests.post"
        ) as post:
            result = service.device_health(DEVICE)

        self.assertIn("500", result["error"])
        self.assertNotIn("registered", result)
        post.assert_not_called()

    def test_an_already_reporting_device_is_untouched(self) -> None:
        service = _service()
        get_responses = [
            _response(200, _device_detail(last_seen="2026-09-09T12:00:00+00:00")),
            _response(200, {"data": [{}, {}]}),
        ]
        with patch("memfault.requests.get", side_effect=get_responses), patch(
            "memfault.requests.post"
        ) as post:
            result = service.device_health(DEVICE)

        self.assertTrue(result["registered"])
        self.assertEqual(result["lastSeen"], "2026-09-09T12:00:00+00:00")
        self.assertEqual(result["recentRebootCount"], 2)
        post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
