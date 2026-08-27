"""Chunk queue state machine tests: pending -> sent, and pending -> retry -> failed."""

import tempfile
import unittest
from pathlib import Path

from storage import DemoStore


def _store(temp_dir: str) -> DemoStore:
    store = DemoStore(str(Path(temp_dir) / "demo.db"))
    store.init_db()
    return store


class MemfaultChunkQueueTests(unittest.TestCase):
    def test_enqueue_then_drain_marks_the_chunk_sent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _store(temp_dir)
            chunk_id = store.enqueue_memfault_chunk(
                wireless_device_id="wid-1",
                device_serial="SERIAL1",
                sequence=1,
                chunk_data=b"\x01\x02",
            )

            due = store.next_memfault_chunk_to_send()
            self.assertIsNotNone(due)
            self.assertEqual(due["id"], chunk_id)
            self.assertEqual(due["chunk_data"], b"\x01\x02")
            self.assertEqual(due["status"], "pending")

            store.mark_memfault_chunk_sent(chunk_id)

            self.assertIsNone(store.next_memfault_chunk_to_send())
            recent = store.list_recent_memfault_chunks()
            self.assertEqual(recent[0]["status"], "sent")

    def test_failed_attempt_reschedules_with_backoff_instead_of_retrying_immediately(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _store(temp_dir)
            chunk_id = store.enqueue_memfault_chunk(
                wireless_device_id="wid-1",
                device_serial="SERIAL1",
                sequence=1,
                chunk_data=b"\x01",
            )

            store.mark_memfault_chunk_attempt_failed(
                chunk_id, attempts=1, error="connection reset", terminal=False, backoff_secs=3600
            )

            # Still queued, but not due again for an hour, so a naive drain loop
            # must not spin on it.
            self.assertIsNone(store.next_memfault_chunk_to_send())

            recent = store.list_recent_memfault_chunks()
            self.assertEqual(recent[0]["status"], "pending")
            self.assertEqual(recent[0]["attempts"], 1)
            self.assertEqual(recent[0]["last_error"], "connection reset")

    def test_exhausting_the_attempt_cap_moves_the_chunk_to_a_terminal_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _store(temp_dir)
            chunk_id = store.enqueue_memfault_chunk(
                wireless_device_id="wid-1",
                device_serial="SERIAL1",
                sequence=1,
                chunk_data=b"\x01",
            )

            store.mark_memfault_chunk_attempt_failed(
                chunk_id, attempts=8, error="still failing", terminal=True, backoff_secs=0
            )

            self.assertIsNone(store.next_memfault_chunk_to_send())
            recent = store.list_recent_memfault_chunks()
            self.assertEqual(recent[0]["status"], "failed")
            self.assertEqual(recent[0]["attempts"], 8)

    def test_a_queued_chunk_survives_reopening_the_database(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _store(temp_dir)
            store.enqueue_memfault_chunk(
                wireless_device_id="wid-1",
                device_serial="SERIAL1",
                sequence=9,
                chunk_data=b"\xaa\xbb",
            )

            reopened = DemoStore(str(store.db_path))
            reopened.init_db()
            due = reopened.next_memfault_chunk_to_send()

            self.assertIsNotNone(due)
            self.assertEqual(due["sequence"], 9)
            self.assertEqual(due["chunk_data"], b"\xaa\xbb")

    def test_device_health_cache_preserves_fields_not_being_updated(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            store = _store(temp_dir)
            store.upsert_memfault_device_health(
                wireless_device_id="wid-1", device_serial="SERIAL1", last_chunk_at="2026-08-20T00:00:00+00:00"
            )
            store.upsert_memfault_device_health(
                wireless_device_id="wid-1",
                device_serial="SERIAL1",
                last_forward_ok=False,
                last_forward_error="HTTP 500",
            )

            health = store.get_memfault_device_health("wid-1")

            self.assertEqual(health["last_chunk_at"], "2026-08-20T00:00:00+00:00")
            self.assertEqual(health["last_forward_ok"], False)
            self.assertEqual(health["last_forward_error"], "HTTP 500")


if __name__ == "__main__":
    unittest.main()
