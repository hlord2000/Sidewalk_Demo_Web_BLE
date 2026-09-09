"""Memfault device registration at AWS device-creation time.

The Sidewalk credentials and the Memfault device are two halves of one demo
device and must be keyed to the same serial, the SMSN. Memfault would create
the device implicitly on its first chunk, but until then the dashboard link is
a 404 and hardware_version/cohort are unset, so the device is registered up
front instead.

Two invariants are load bearing here:
  - the call is idempotent, because Memfault answers 409 for a known serial
  - it never fails the AWS create, because a wireless device that exists in
    AWS but not in this app's database is invisible and has to be cleaned up
    by hand
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


SMSN = "A" * 64


def _service(**overrides):
    config = type("Config", (_Config,), overrides)
    return MemfaultService(config, Mock(), Mock())


def _response(status_code: int, ok: bool | None = None):
    response = Mock()
    response.status_code = status_code
    response.ok = (status_code < 400) if ok is None else ok
    response.text = ""
    return response


class EnsureDeviceTests(unittest.TestCase):
    def test_creates_the_device_with_the_configured_hardware_version(self) -> None:
        service = _service()
        with patch("memfault.requests.post", return_value=_response(200)) as post:
            result = service.ensure_device(SMSN)

        self.assertTrue(result["ok"])
        self.assertTrue(result["created"])
        self.assertFalse(result["existed"])

        url, kwargs = post.call_args[0][0], post.call_args[1]
        self.assertEqual(
            url,
            "https://api.memfault.com/api/v0/organizations/org/projects/proj/devices",
        )
        self.assertEqual(
            kwargs["json"],
            {"device_serial": SMSN, "hardware_version": "sidewalk_devkit_nrf54l15"},
        )
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer token")

    def test_conflict_is_success_so_the_call_is_idempotent(self) -> None:
        """Memfault documents 409 as the expected answer for a known serial."""
        service = _service()
        with patch("memfault.requests.post", return_value=_response(409)):
            result = service.ensure_device(SMSN)

        self.assertTrue(result["ok"], "409 means the device is registered, which is the goal")
        self.assertTrue(result["existed"])
        self.assertFalse(result["created"])

    def test_real_http_failure_is_reported_not_raised(self) -> None:
        service = _service()
        with patch("memfault.requests.post", return_value=_response(403)):
            result = service.ensure_device(SMSN)

        self.assertFalse(result["ok"])
        self.assertEqual(result["statusCode"], 403)
        self.assertIn("403", result["error"])

    def test_missing_hardware_version_explains_the_firmware_coupling(self) -> None:
        service = _service(MEMFAULT_HARDWARE_VERSION="")
        with patch("memfault.requests.post") as post:
            result = service.ensure_device(SMSN)

        self.assertFalse(result["ok"])
        self.assertIn("CONFIG_MEMFAULT_NCS_HW_VERSION", result["error"])
        post.assert_not_called()

    def test_unconfigured_read_api_is_reported_as_unconfigured(self) -> None:
        service = _service(MEMFAULT_ORG_AUTH_TOKEN="")
        with patch("memfault.requests.post") as post:
            result = service.ensure_device(SMSN)

        self.assertFalse(result["ok"])
        self.assertFalse(result["configured"])
        post.assert_not_called()

    def test_cohort_and_nickname_are_applied_in_a_follow_up_patch(self) -> None:
        service = _service(MEMFAULT_COHORT="demo-fleet")
        with patch("memfault.requests.post", return_value=_response(200)), patch(
            "memfault.requests.patch", return_value=_response(200)
        ) as patch_call:
            result = service.ensure_device(SMSN, nickname="Booth Unit 1")

        self.assertTrue(result["ok"])
        self.assertEqual(
            patch_call.call_args[0][0],
            f"https://api.memfault.com/api/v0/organizations/org/projects/proj/devices/{SMSN}",
        )
        self.assertEqual(
            patch_call.call_args[1]["json"],
            {"cohort": "demo-fleet", "nickname": "Booth Unit 1"},
        )

    def test_no_patch_when_there_is_nothing_to_set(self) -> None:
        service = _service()
        with patch("memfault.requests.post", return_value=_response(200)), patch(
            "memfault.requests.patch"
        ) as patch_call:
            service.ensure_device(SMSN)

        patch_call.assert_not_called()

    def test_failed_attribute_patch_still_leaves_the_device_registered(self) -> None:
        """The device existing is what the caller asked for; a label is cosmetic."""
        service = _service(MEMFAULT_COHORT="demo-fleet")
        with patch("memfault.requests.post", return_value=_response(200)), patch(
            "memfault.requests.patch", return_value=_response(400)
        ):
            result = service.ensure_device(SMSN)

        self.assertTrue(result["ok"])
        self.assertIn("400", result["attributeError"])

    def test_network_error_is_reported_not_raised(self) -> None:
        import requests

        service = _service()
        with patch("memfault.requests.post", side_effect=requests.ConnectionError("no route")):
            result = service.ensure_device(SMSN)

        self.assertFalse(result["ok"])
        self.assertIn("no route", result["error"])


class EnsureDeviceForTests(unittest.TestCase):
    """ensure_device_for() must pick the same serial the chunk forwarder uses."""

    def test_serial_comes_from_the_smsn_not_the_wireless_device_id(self) -> None:
        service = _service()
        device = {
            "name": "Booth Unit 1",
            "wireless_device_id": "wd-123",
            "wireless_device_json": {"Sidewalk": {"SidewalkManufacturingSn": SMSN}},
            "provisioning_json": None,
        }

        with patch("memfault.requests.post", return_value=_response(200)) as post, patch(
            "memfault.requests.patch", return_value=_response(200)
        ) as patch_call:
            result = service.ensure_device_for(device)

        self.assertTrue(result["ok"])
        self.assertEqual(post.call_args[1]["json"]["device_serial"], SMSN)
        # Same serial the forwarder posts chunks under, which is what makes the
        # pre-created device and the incoming chunks land on one Memfault device.
        self.assertEqual(service.device_serial_for(device), SMSN)
        self.assertEqual(patch_call.call_args[1]["json"], {"nickname": "Booth Unit 1"})

    def test_blank_device_without_an_smsn_falls_back_to_the_wireless_id(self) -> None:
        service = _service()
        device = {"name": "Blank", "wireless_device_id": "wd-123"}

        with patch("memfault.requests.post", return_value=_response(200)) as post:
            service.ensure_device_for(device)

        self.assertEqual(post.call_args[1]["json"]["device_serial"], "wd-123")


if __name__ == "__main__":
    unittest.main()
