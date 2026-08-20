"""End-to-end tests for the BLE NUS provisioning endpoints and outcome tracking.

Follows the tests/test_api_messages.py pattern: point the environment at a
throwaway database before importing app, since app.py builds its store and
seeds the admin user at import time.
"""

import base64
import io
import json
import os
import secrets
import tempfile
import unittest
from pathlib import Path

_TEMP_DIR = tempfile.mkdtemp()
os.environ.setdefault("DATABASE_PATH", str(Path(_TEMP_DIR) / "demo.db"))
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ.setdefault("ADMIN_PASSWORD", "admin-password")
os.environ.setdefault("FLASK_SECRET_KEY", "test-secret")

import app as app_module  # noqa: E402  (import must follow the environment setup)


def _fake_cert_chain_b64(public_key_size: int) -> str:
    """A base64 cert chain shaped the way provisioning._parse_cert_chain expects.

    Six tiers (device, dak, product, man, sw, root), each serial+pubkey+sig.
    The "device" tier's serial slot is SMSN-sized; every other tier's serial
    is a plain 4 zero bytes, which avoids the 0xB0000000 expansion marker
    _serial_length() checks for. Content within each field is irrelevant to
    the parser; only field lengths and the concatenation order matter.
    """
    import secrets as _secrets

    chain = bytearray()
    chain += _secrets.token_bytes(32)  # device serial (SMSN-sized slot)
    chain += _secrets.token_bytes(public_key_size)
    chain += _secrets.token_bytes(64)
    for _ in range(5):  # dak, product, man, sw, root
        chain += b"\x00\x00\x00\x00"
        chain += _secrets.token_bytes(public_key_size)
        chain += _secrets.token_bytes(64)
    return base64.b64encode(bytes(chain)).decode("ascii")


def _valid_certificate_json() -> dict:
    return {
        "p256R1": _fake_cert_chain_b64(64),
        "eD25519": _fake_cert_chain_b64(32),
        "applicationServerPublicKey": secrets.token_bytes(32).hex(),
        "metadata": {
            "deviceTypeId": "ab12",
            "applicationDeviceArn": "arn:aws:iotwireless:us-east-1:123456789012:WirelessDevice/abc",
            "applicationDeviceId": "abc-123",
            "smsn": secrets.token_bytes(32).hex(),
            "devicePrivKeyP256R1": secrets.token_bytes(32).hex(),
            "devicePrivKeyEd25519": secrets.token_bytes(32).hex(),
        },
    }


class ProvisioningEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        app_module.app.config["TESTING"] = True
        self.store = app_module.store

        self.provisioner = self.store.create_customer(
            email=f"prov-{self.id()}@example.com",
            password="customer-password",
            display_name="Provisioner",
            notes="",
            can_provision=True,
        )
        self.plain_customer = self.store.create_customer(
            email=f"plain-{self.id()}@example.com",
            password="customer-password",
            display_name="Plain",
            notes="",
            can_provision=False,
        )
        self.device = self.store.create_device_record(
            customer_user_id=self.provisioner["id"],
            name=f"Device-{self.id()}",
            description="",
            wireless_device_id=f"wid-{self.id()}",
            destination_name="TEST",
            uplink_topic="test/topic",
            device_profile_id="profile-id",
            ble_name_prefix="WebShell",
        )
        self.store.update_device_customers(self.device["id"], [self.provisioner["id"], self.plain_customer["id"]])

    def _client(self, email: str, password: str):
        client = app_module.app.test_client()
        response = client.post("/login", data={"email": email, "password": password})
        self.assertIn(response.status_code, (302, 303))
        return client

    def _admin_client(self):
        return self._client("admin@example.com", "admin-password")

    def _provisioner_client(self):
        return self._client(self.provisioner["email"], "customer-password")

    def _plain_customer_client(self):
        return self._client(self.plain_customer["email"], "customer-password")

    def _upload_certificate_json(self, client, data: dict):
        return client.post(
            f"/admin/devices/{self.device['id']}/certificate-json",
            data={"certificate_json": (io.BytesIO(json.dumps(data).encode("utf-8")), "certificate.json")},
            content_type="multipart/form-data",
        )

    def test_certificate_json_upload_then_values_endpoint_round_trips_credentials(self) -> None:
        cert_json = _valid_certificate_json()
        admin = self._admin_client()
        uploaded = self._upload_certificate_json(admin, cert_json)
        self.assertEqual(uploaded.status_code, 200)
        self.assertTrue(uploaded.get_json()["ok"])

        provisioner = self._provisioner_client()
        response = provisioner.get(f"/api/devices/{self.device['id']}/provisioning-values")
        body = response.get_json()

        self.assertTrue(body["ok"])
        smsn_entry = body["values"]["4"]
        self.assertEqual(smsn_entry["name"], "SID_PAL_MFG_STORE_SMSN")
        self.assertEqual(smsn_entry["length"], 32)
        self.assertEqual(base64.b64decode(smsn_entry["base64"]).hex(), cert_json["metadata"]["smsn"])

    def test_certificate_json_upload_never_echoes_the_private_keys(self) -> None:
        cert_json = _valid_certificate_json()
        admin = self._admin_client()
        response = self._upload_certificate_json(admin, cert_json)

        body_text = response.get_data(as_text=True)
        self.assertNotIn(cert_json["metadata"]["devicePrivKeyEd25519"], body_text)
        self.assertNotIn(cert_json["metadata"]["devicePrivKeyP256R1"], body_text)

    def test_certificate_json_upload_rejects_invalid_payloads(self) -> None:
        admin = self._admin_client()
        bad = _valid_certificate_json()
        del bad["metadata"]["smsn"]

        response = self._upload_certificate_json(admin, bad)

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()["ok"])

    def test_provisioning_script_starts_with_erase_and_ends_with_reboot(self) -> None:
        admin = self._admin_client()
        self._upload_certificate_json(admin, _valid_certificate_json())

        provisioner = self._provisioner_client()
        response = provisioner.get(f"/api/devices/{self.device['id']}/provisioning-script")
        body = response.get_json()

        self.assertTrue(body["ok"])
        self.assertEqual(body["commands"][0], "prov erase")
        self.assertEqual(body["commands"][-1], "prov reboot")
        self.assertEqual(body["commands"][-2], "prov finalize")
        self.assertEqual(body["terminalEvent"]["type"], "provdone")

    def test_provisioning_endpoints_require_provisioning_permission(self) -> None:
        admin = self._admin_client()
        self._upload_certificate_json(admin, _valid_certificate_json())

        plain = self._plain_customer_client()
        values_response = plain.get(f"/api/devices/{self.device['id']}/provisioning-values")
        script_response = plain.get(f"/api/devices/{self.device['id']}/provisioning-script")

        self.assertEqual(values_response.status_code, 403)
        self.assertEqual(script_response.status_code, 403)

    def test_provisioning_values_endpoint_reports_a_clear_error_with_no_artifacts(self) -> None:
        bare_device = self.store.create_device_record(
            customer_user_id=self.provisioner["id"],
            name=f"Bare-{self.id()}",
            description="",
            wireless_device_id=f"bare-wid-{self.id()}",
            destination_name="TEST",
            uplink_topic="test/topic",
            device_profile_id="",
            ble_name_prefix="WebShell",
        )
        provisioner = self._provisioner_client()

        response = provisioner.get(f"/api/devices/{bare_device['id']}/provisioning-values")

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()["ok"])

    def test_provdone_line_marks_the_device_succeeded_or_failed(self) -> None:
        provisioner = self._provisioner_client()
        provisioner.post(
            "/api/ble-log",
            json={
                "deviceId": self.device["id"],
                "lines": ['EVT:{"t":"provdone","ok":true}'],
            },
        )

        updated = self.store.get_device(self.device["id"])
        self.assertEqual(updated["provisioning_status"], "succeeded")

        provisioner.post(
            "/api/ble-log",
            json={
                "deviceId": self.device["id"],
                "lines": ['EVT:{"t":"provdone","ok":false,"err":"flash write failed"}'],
            },
        )

        updated = self.store.get_device(self.device["id"])
        self.assertEqual(updated["provisioning_status"], "failed")
        self.assertEqual(updated["provisioning_status_reason"], "flash write failed")

    def test_boot_time_prov_event_confirms_verified_only_when_provisioned_true(self) -> None:
        provisioner = self._provisioner_client()
        smsn = secrets.token_bytes(32).hex()

        provisioner.post(
            "/api/ble-log",
            json={
                "deviceId": self.device["id"],
                "lines": [f'EVT:{{"t":"prov","provisioned":true,"smsn":"{smsn}","mfg_ver":8}}'],
            },
        )

        updated = self.store.get_device(self.device["id"])
        self.assertEqual(updated["provisioning_status"], "verified")

    def test_blank_boot_announcement_does_not_record_a_failure(self) -> None:
        provisioner = self._provisioner_client()

        provisioner.post(
            "/api/ble-log",
            json={
                "deviceId": self.device["id"],
                "lines": ['EVT:{"t":"prov","provisioned":false,"smsn":"","mfg_ver":8}'],
            },
        )

        events = self.store.list_provisioning_events(self.device["id"])
        self.assertEqual(events, [])

    def test_provisioning_status_endpoint_records_an_attempt_and_shows_in_summary(self) -> None:
        provisioner = self._provisioner_client()

        response = provisioner.post(
            f"/api/devices/{self.device['id']}/provisioning-status",
            json={"status": "attempted"},
        )

        self.assertTrue(response.get_json()["ok"])
        self.assertEqual(response.get_json()["device"]["provisioningStatus"], "attempted")

    def test_provisioning_status_endpoint_rejects_an_unknown_status(self) -> None:
        provisioner = self._provisioner_client()

        response = provisioner.post(
            f"/api/devices/{self.device['id']}/provisioning-status",
            json={"status": "not-a-real-status"},
        )

        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
