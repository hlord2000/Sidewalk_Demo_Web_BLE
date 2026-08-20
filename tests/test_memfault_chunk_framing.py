import unittest

from iot import MEMFAULT_CHUNK_TAG, _memfault_chunk_from_payload


class MemfaultChunkFramingTests(unittest.TestCase):
    def test_detects_and_strips_tag_and_sequence(self) -> None:
        raw = bytes([MEMFAULT_CHUNK_TAG, 7]) + b"\x01\x02\x03"

        result = _memfault_chunk_from_payload(raw)

        self.assertIsNotNone(result)
        sequence, chunk = result
        self.assertEqual(sequence, 7)
        self.assertEqual(chunk, b"\x01\x02\x03")

    def test_sequence_wraps_and_chunk_bytes_pass_through_verbatim(self) -> None:
        # 0x7b looks like '{' if this ever got treated as text; it must not be.
        raw = bytes([MEMFAULT_CHUNK_TAG, 255, 0x00, 0xFF, 0x7B])

        sequence, chunk = _memfault_chunk_from_payload(raw)

        self.assertEqual(sequence, 255)
        self.assertEqual(chunk, b"\x00\xff\x7b")

    def test_empty_chunk_body_is_still_detected(self) -> None:
        raw = bytes([MEMFAULT_CHUNK_TAG, 0])

        sequence, chunk = _memfault_chunk_from_payload(raw)

        self.assertEqual(sequence, 0)
        self.assertEqual(chunk, b"")

    def test_non_chunk_payload_returns_none(self) -> None:
        self.assertIsNone(_memfault_chunk_from_payload(b"\x01\x02\x03"))
        self.assertIsNone(_memfault_chunk_from_payload(b"{\"a\":1}"))

    def test_too_short_payload_returns_none(self) -> None:
        self.assertIsNone(_memfault_chunk_from_payload(bytes([MEMFAULT_CHUNK_TAG])))
        self.assertIsNone(_memfault_chunk_from_payload(b""))


if __name__ == "__main__":
    unittest.main()
