import sqlite3
import tempfile
import unittest
from pathlib import Path

from storage import DemoStore


class DemoStoreTests(unittest.TestCase):
    def test_init_enables_wal_journal_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            database_path = Path(temp_dir) / "demo.db"
            store = DemoStore(str(database_path))
            store.init_db()

            with sqlite3.connect(database_path) as connection:
                journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]

            self.assertEqual(journal_mode.lower(), "wal")

    def test_update_device_name_keeps_wireless_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = DemoStore(str(Path(temp_dir) / "demo.db"))
            store.init_db()
            device = store.create_device_record(
                customer_user_id=None,
                name="AODemo1",
                description="",
                wireless_device_id="7a5077c6-91ac-4abf-92b9-e8bc07730ea7",
                destination_name="TEST",
                uplink_topic="test/topic",
                device_profile_id="profile-id",
                ble_name_prefix="WebShell",
            )

            store.update_device_name(device["id"], "AODemo_Original")
            renamed = store.get_device(device["id"])

            self.assertEqual(renamed["name"], "AODemo_Original")
            self.assertEqual(
                renamed["wireless_device_id"],
                "7a5077c6-91ac-4abf-92b9-e8bc07730ea7",
            )


if __name__ == "__main__":
    unittest.main()
