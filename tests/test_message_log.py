import tempfile
import unittest
from pathlib import Path

from storage import MESSAGE_LOG_CAP, DemoStore


def _store(temp_dir: str) -> DemoStore:
    store = DemoStore(str(Path(temp_dir) / "demo.db"))
    store.init_db()
    return store


class MessageLogTests(unittest.TestCase):
    def test_messages_resolve_the_device_they_came_from(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _store(temp_dir)
            store.create_device_record(
                customer_user_id=None,
                name="AODemo1",
                description="",
                wireless_device_id="wid-1",
                destination_name="TEST",
                uplink_topic="test/topic",
                device_profile_id="profile-id",
                ble_name_prefix="WebShell",
            )
            store.record_message(
                ts="2026-08-19T12:00:00+00:00",
                source="sidewalk",
                event_type="uplink",
                wireless_device_id="wid-1",
                link_name="BLE",
                payload_text="button",
                payload_json={"event": "button"},
            )

            messages = store.list_messages()

            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0]["device_name"], "AODemo1")
            self.assertEqual(messages[0]["wireless_device_id"], "wid-1")
            self.assertEqual(messages[0]["payload_json"], {"event": "button"})

    def test_unidentified_ble_lines_are_kept_without_a_device(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _store(temp_dir)
            store.record_message(
                ts="",
                source="ble",
                event_type="ble_shell",
                ble_name="WebShell-Old",
                detail="EVT:{\"t\":\"status\"}",
            )

            messages = store.list_messages()

            self.assertEqual(len(messages), 1)
            self.assertIsNone(messages[0]["wireless_device_id"])
            self.assertIsNone(messages[0]["device_name"])
            self.assertEqual(messages[0]["ble_name"], "WebShell-Old")
            self.assertTrue(messages[0]["ts"], "a missing timestamp should default to now")

    def test_listing_is_newest_first_and_filters_by_source_and_device(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _store(temp_dir)
            for index in range(3):
                store.record_message(
                    ts=f"2026-08-19T12:0{index}:00+00:00",
                    source="sidewalk",
                    event_type="uplink",
                    wireless_device_id="wid-1",
                    payload_text=f"cloud-{index}",
                )
            store.record_message(
                ts="2026-08-19T12:05:00+00:00",
                source="ble",
                event_type="ble_shell",
                wireless_device_id="wid-2",
                detail="shell line",
            )

            newest_first = store.list_messages()
            self.assertEqual(newest_first[0]["detail"], "shell line")

            self.assertEqual(len(store.list_messages(source="ble")), 1)
            self.assertEqual(len(store.list_messages(source="sidewalk")), 3)
            self.assertEqual(len(store.list_messages(wireless_device_id="wid-1")), 3)
            self.assertEqual(len(store.list_messages(wireless_device_id="wid-2")), 1)

    def test_after_id_returns_only_newer_messages(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _store(temp_dir)
            for index in range(4):
                store.record_message(
                    ts="",
                    source="ble",
                    event_type="ble_shell",
                    detail=f"line-{index}",
                )

            seen = store.list_messages()
            cursor = seen[0]["id"]
            self.assertEqual(store.list_messages(after_id=cursor), [])

            store.record_message(ts="", source="ble", event_type="ble_shell", detail="line-4")
            fresh = store.list_messages(after_id=cursor)

            self.assertEqual([item["detail"] for item in fresh], ["line-4"])

    def test_writing_prunes_messages_older_than_the_cap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _store(temp_dir)
            # Seed one ancient row and one recent row without writing thousands,
            # then confirm the next write drops what fell outside the cap.
            with store.connect() as conn:
                for row_id in (1, MESSAGE_LOG_CAP + 1):
                    conn.execute(
                        "INSERT INTO messages (id, ts, source, event_type, detail, created_at)"
                        " VALUES (?, '2026-08-19T12:00:00+00:00', 'ble', 'ble_shell', ?,"
                        " '2026-08-19T12:00:00+00:00')",
                        (row_id, f"row-{row_id}"),
                    )
            store.record_message(ts="", source="ble", event_type="ble_shell", detail="newest")

            remaining = {message["id"]: message["detail"] for message in store.list_messages()}

            self.assertNotIn(1, remaining, "a row beyond the cap should be pruned")
            self.assertIn(MESSAGE_LOG_CAP + 1, remaining)
            self.assertEqual(store.list_messages()[0]["detail"], "newest")


if __name__ == "__main__":
    unittest.main()
