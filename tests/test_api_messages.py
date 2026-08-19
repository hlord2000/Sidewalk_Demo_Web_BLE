"""End-to-end tests for the BLE log intake and the admin message feed.

The app module builds its store and seeds the admin at import time, so the
environment is pointed at a throwaway database before importing it.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

_TEMP_DIR = tempfile.TemporaryDirectory()
os.environ["DATABASE_PATH"] = str(Path(_TEMP_DIR.name) / "demo.db")
os.environ["ADMIN_EMAIL"] = "admin@example.com"
os.environ["ADMIN_PASSWORD"] = "admin-password"
os.environ["FLASK_SECRET_KEY"] = "test-secret"

import app as app_module  # noqa: E402  (import must follow the environment setup)


class AdminMessageApiTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls) -> None:
        _TEMP_DIR.cleanup()

    def setUp(self) -> None:
        app_module.app.config["TESTING"] = True
        self.store = app_module.store
        with self.store.connect() as conn:
            conn.execute("DELETE FROM messages")

        self.customer = self.store.create_customer(
            email=f"customer-{self.id()}@example.com",
            password="customer-password",
            display_name="Customer",
            notes="",
            can_provision=False,
        )
        self.device = self.store.create_device_record(
            customer_user_id=self.customer["id"],
            name="AODemo1",
            description="",
            wireless_device_id=f"wid-{self.id()}",
            destination_name="TEST",
            uplink_topic="test/topic",
            device_profile_id="profile-id",
            ble_name_prefix="WebShell",
        )
        self.other_device = self.store.create_device_record(
            customer_user_id=None,
            name="SomeoneElse",
            description="",
            wireless_device_id=f"other-wid-{self.id()}",
            destination_name="TEST",
            uplink_topic="test/topic",
            device_profile_id="profile-id",
            ble_name_prefix="WebShell",
        )

    def _client(self, email: str, password: str):
        client = app_module.app.test_client()
        response = client.post(
            "/login",
            data={"email": email, "password": password},
            follow_redirects=False,
        )
        self.assertIn(response.status_code, (302, 303), "login should redirect")
        return client

    def _admin_client(self):
        return self._client("admin@example.com", "admin-password")

    def _customer_client(self):
        return self._client(self.customer["email"], "customer-password")

    @staticmethod
    def _next_chunk(events) -> str:
        chunk = next(events)
        return chunk.decode() if isinstance(chunk, bytes) else chunk

    def _next_streamed_row(self, events) -> dict:
        return json.loads(self._next_chunk(events).split("data: ", 1)[1])

    def test_ble_lines_reach_the_admin_feed_with_their_device_id(self) -> None:
        customer = self._customer_client()
        posted = customer.post(
            "/api/ble-log",
            json={
                "deviceId": self.device["id"],
                "bleName": "WebShell-1A2B",
                "lines": ["uart:~$ sid flow sensor ble", "EVT:{\"t\":\"status\"}"],
            },
        )
        self.assertEqual(posted.status_code, 200)
        self.assertEqual(posted.get_json()["stored"], 2)

        admin = self._admin_client()
        feed = admin.get("/api/admin/messages").get_json()

        self.assertTrue(feed["ok"])
        self.assertEqual(feed["count"], 2)
        for message in feed["messages"]:
            self.assertEqual(message["source"], "ble")
            self.assertEqual(message["wireless_device_id"], self.device["wireless_device_id"])
            self.assertEqual(message["device_name"], "AODemo1")
            self.assertEqual(message["ble_name"], "WebShell-1A2B")

    def test_unverified_board_is_logged_without_a_device_id(self) -> None:
        customer = self._customer_client()
        posted = customer.post(
            "/api/ble-log",
            json={"deviceId": None, "bleName": "WebShell-Old", "lines": ["hello"]},
        )
        self.assertEqual(posted.status_code, 200)

        admin = self._admin_client()
        message = admin.get("/api/admin/messages").get_json()["messages"][0]

        self.assertIsNone(message["wireless_device_id"])
        self.assertEqual(message["ble_name"], "WebShell-Old")
        self.assertEqual(message["detail"], "hello")

    def test_posting_for_someone_elses_device_is_rejected(self) -> None:
        customer = self._customer_client()
        response = customer.post(
            "/api/ble-log",
            json={"deviceId": self.other_device["id"], "lines": ["snooping"]},
        )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.store.list_messages(), [])

    def test_blank_and_oversized_input_is_bounded(self) -> None:
        customer = self._customer_client()
        response = customer.post(
            "/api/ble-log",
            json={
                "deviceId": self.device["id"],
                "lines": ["  ", "", "x" * 900] + [f"line-{i}" for i in range(400)],
            },
        )
        self.assertEqual(response.status_code, 200)

        stored = self.store.list_messages(limit=1000)
        self.assertEqual(len(stored), app_module.BLE_LOG_MAX_LINES - 2)
        longest = max(len(message["detail"]) for message in stored)
        self.assertEqual(longest, app_module.BLE_LOG_MAX_LINE_CHARS)

    def test_lines_must_be_a_list(self) -> None:
        customer = self._customer_client()
        response = customer.post("/api/ble-log", json={"lines": "not-a-list"})

        self.assertEqual(response.status_code, 400)

    def test_sidewalk_uplinks_are_mirrored_into_the_log(self) -> None:
        app_module.broker.publish(
            {
                "type": "uplink",
                "wireless_device_id": self.device["wireless_device_id"],
                "link_name": "BLE",
                "payload_text": "button",
                "payload_hex": "627574746f6e",
                "payload_json": {"event": "button"},
            }
        )

        admin = self._admin_client()
        message = admin.get("/api/admin/messages?source=sidewalk").get_json()["messages"][0]

        self.assertEqual(message["event_type"], "uplink")
        self.assertEqual(message["wireless_device_id"], self.device["wireless_device_id"])
        self.assertEqual(message["payload_json"], {"event": "button"})
        self.assertEqual(message["link_name"], "BLE")

    def test_service_status_chatter_is_not_logged(self) -> None:
        app_module.broker.publish(
            {
                "type": "service_status",
                "state": "connected",
                "detail": "MQTT uplink listener connected",
            }
        )

        self.assertEqual(self.store.list_messages(), [])

    def test_ble_lines_arrive_on_the_live_stream(self) -> None:
        admin = self._admin_client()
        response = admin.get("/api/admin/stream")
        events = response.response
        # Reading the first chunk registers the listener before anything is published.
        self.assertIn("retry:", self._next_chunk(events))

        customer = self._customer_client()
        customer.post(
            "/api/ble-log",
            json={
                "deviceId": self.device["id"],
                "bleName": "WebShell-1A2B",
                "lines": ["uart:~$ sid flow status"],
            },
        )

        payload = self._next_streamed_row(events)
        response.close()

        self.assertEqual(payload["source"], "ble")
        self.assertEqual(payload["event_type"], "ble_shell")
        self.assertEqual(payload["detail"], "uart:~$ sid flow status")
        self.assertEqual(payload["wireless_device_id"], self.device["wireless_device_id"])
        self.assertEqual(payload["device_name"], "AODemo1")
        self.assertTrue(payload["id"], "streamed rows carry the log id used as a cursor")

    def test_uplinks_arrive_on_the_live_stream_with_their_log_id(self) -> None:
        admin = self._admin_client()
        response = admin.get("/api/admin/stream")
        events = response.response
        self._next_chunk(events)

        app_module.broker.publish(
            {
                "type": "uplink",
                "wireless_device_id": self.device["wireless_device_id"],
                "link_name": "BLE",
                "payload_text": "button",
            }
        )

        payload = self._next_streamed_row(events)
        response.close()

        self.assertEqual(payload["event_type"], "uplink")
        self.assertEqual(payload["source"], "sidewalk")
        self.assertEqual(payload["payload_text"], "button")
        stored = self.store.list_messages()[0]
        self.assertEqual(payload["id"], stored["id"])

    def test_ble_lines_stay_off_the_customer_event_stream(self) -> None:
        customer = self._customer_client()
        customer.post(
            "/api/ble-log",
            json={"deviceId": self.device["id"], "lines": ["private shell output"]},
        )

        # Nothing BLE-shaped may sit in the dashboard broker's backlog.
        listener, history = app_module.broker.open_stream(0)
        app_module.broker.close_stream(listener)

        self.assertEqual([event for event in history if event.get("type") == "ble_shell"], [])

    def test_customers_cannot_read_the_live_stream(self) -> None:
        customer = self._customer_client()
        response = customer.get("/api/admin/stream")

        self.assertIn(response.status_code, (302, 303))

    def test_customers_cannot_read_the_admin_feed(self) -> None:
        customer = self._customer_client()
        response = customer.get("/api/admin/messages")

        with app_module.app.test_request_context():
            dashboard_url = app_module.url_for("dashboard")
        self.assertIn(response.status_code, (302, 303))
        self.assertEqual(response.headers.get("Location"), dashboard_url)

    def test_signed_out_visitors_cannot_post_ble_logs(self) -> None:
        client = app_module.app.test_client()
        response = client.post("/api/ble-log", json={"lines": ["nope"]})

        self.assertIn(response.status_code, (302, 303))
        self.assertEqual(self.store.list_messages(), [])


if __name__ == "__main__":
    unittest.main()
