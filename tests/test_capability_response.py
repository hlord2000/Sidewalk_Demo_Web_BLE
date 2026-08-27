"""The firmware will not send telemetry until the cloud answers capability discovery.

app_rx.c raises APP_EVENT_CAPABILITY_SUCCESS only for a RESP to capability
discovery that carries a status header of SID_ERROR_NONE and an empty payload,
and app_tx.c needs that event to leave STATE_APP_NOTIFY_CAPABILITY. If the
bytes below drift, the device silently resends capability forever and the
sensor monitor never populates, so pin them.
"""

import iot


def test_capability_response_bytes():
    # status header present, opcode RESP (3), class 0, command id 0, then
    # SID_ERROR_NONE. Offsets come from enum sid_demo_msg_desc_attributes.
    assert iot.SID_DEMO_CAPABILITY_RESPONSE == bytes([0xE0, 0x00])


def test_recognises_the_real_capability_uplink():
    # Captured off the wire from a XIAO nRF54L15: capability discovery notify
    # with 4 buttons, 4 LEDs, temperature units and link type.
    uplink = bytes.fromhex("40810001020382000102030b010c01")
    assert iot._is_capability_discovery_notify(uplink)


def test_does_not_answer_its_own_response():
    """Guards against an uplink/downlink loop if the response is ever echoed back."""
    assert not iot._is_capability_discovery_notify(iot.SID_DEMO_CAPABILITY_RESPONSE)


def test_ignores_other_demo_messages_and_empty_payloads():
    # A button-press action notify (cmd id 1) must not be answered.
    assert not iot._is_capability_discovery_notify(bytes([0x41]))
    assert not iot._is_capability_discovery_notify(b"")


def test_uplink_bytes_are_recovered_from_ascii_hex():
    """Sidewalk delivers these payloads as ASCII hex, not raw bytes."""
    demo = bytes.fromhex("40810001020382000102030b010c01")
    ascii_hex = demo.hex()
    assert iot._sid_demo_bytes_from_uplink(ascii_hex.encode("ascii"), ascii_hex) == demo


def test_raw_bytes_still_work_when_not_hex():
    raw = bytes([0x40, 0xFF])
    assert iot._sid_demo_bytes_from_uplink(raw, "") == raw


def test_binary_downlink_is_not_utf8_encoded():
    """0xE0 is not valid UTF-8 alone, so a text-only path would corrupt it."""
    request = iot.DownlinkRequest(
        text="",
        payload=iot.SID_DEMO_CAPABILITY_RESPONSE,
        wireless_device_id="wd-1",
        device_name="",
    )
    assert request.payload == b"\xe0\x00"
    assert request.payload != "\xe0\x00".encode("utf-8")
