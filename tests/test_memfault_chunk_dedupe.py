"""Duplicate chunks must not reach Memfault.

Uplinks are subscribed at MQTT QoS 1, which permits redelivery. A Memfault
heartbeat spans two chunks (a 0x48 opener and a 0x80 continuation), and a
repeated continuation corrupts Memfault's server-side reassembly: the message
is dropped there while every POST still returns 202, so the device silently
goes stale. Observed in production as last_seen frozen at the last reboot while
the chunk queue showed nothing but status=sent.
"""

from storage import DemoStore


def _store(tmp_path):
    store = DemoStore(str(tmp_path / "dedupe.db"))
    store.init_db()
    return store


def _enqueue(store, data, sequence=7):
    return store.enqueue_memfault_chunk(
        wireless_device_id="wd-1",
        device_serial="SERIAL1",
        sequence=sequence,
        chunk_data=data,
    )


def test_identical_chunk_is_dropped(tmp_path):
    store = _store(tmp_path)
    continuation = bytes.fromhex("805ef619781ef091")
    first = _enqueue(store, continuation)
    second = _enqueue(store, continuation)
    assert first > 0, "the first chunk must be queued"
    assert second == 0, "a redelivered chunk must be dropped, not queued again"


def test_different_continuations_both_queue(tmp_path):
    """Two heartbeats produce different continuation bytes; neither may be lost."""
    store = _store(tmp_path)
    a = _enqueue(store, bytes.fromhex("805ef619781ef091"))
    b = _enqueue(store, bytes.fromhex("805ef6197724dff1"))
    assert a > 0 and b > 0 and a != b


def test_same_bytes_from_a_different_device_still_queues(tmp_path):
    store = _store(tmp_path)
    data = bytes.fromhex("805ef619781ef091")
    first = _enqueue(store, data)
    other = store.enqueue_memfault_chunk(
        wireless_device_id="wd-2",
        device_serial="SERIAL2",
        sequence=7,
        chunk_data=data,
    )
    assert first > 0 and other > 0, "dedupe must be scoped per device"


def test_opener_and_continuation_both_queue(tmp_path):
    """The 96 byte opener and its 8 byte continuation are one message, not a repeat."""
    store = _store(tmp_path)
    opener = bytes.fromhex("486202a7020103010a6d7369646577616c")
    continuation = bytes.fromhex("805ef619781ef091")
    assert _enqueue(store, opener, sequence=1) > 0
    assert _enqueue(store, continuation, sequence=2) > 0
