"""The crash downlink is one byte, and the firmware decodes it by bit field.

app_rx_diag_process() in app_rx.c reads the sid_demo descriptor byte: opcode
WRITE, command class 1 (unused by the demo protocol), and the command id in the
low three bits. If these bytes drift the device silently ignores the request, so
pin them against the firmware's constants.
"""

import pytest

import iot


def test_diagnostic_bytes_match_the_firmware():
    # APP_RX_DIAG_CLASS 0x1, commands 0 assert / 1 hardfault / 2 reboot.
    assert iot.sid_demo_diagnostic_downlink("assert") == bytes([0x28])
    assert iot.sid_demo_diagnostic_downlink("hardfault") == bytes([0x29])
    assert iot.sid_demo_diagnostic_downlink("reboot") == bytes([0x2A])


def test_downlink_is_a_single_byte():
    """Sub-GHz payload budget can be 19 bytes, so this must stay minimal."""
    for command in iot.DIAG_COMMANDS:
        assert len(iot.sid_demo_diagnostic_downlink(command)) == 1


def test_diagnostic_header_decodes_as_write_on_class_one():
    for command, cmd_id in iot.DIAG_COMMANDS.items():
        header = iot.sid_demo_diagnostic_downlink(command)[0]
        assert (header >> 7) & 1 == 0, f"{command}: status header must be absent"
        assert (header >> 5) & 0x3 == 0x1, f"{command}: opcode must be WRITE"
        assert (header >> 3) & 0x3 == 0x1, f"{command}: must use the diagnostic class"
        assert header & 0x7 == cmd_id, f"{command}: command id mismatch"


def test_unknown_command_is_rejected():
    with pytest.raises(ValueError):
        iot.sid_demo_diagnostic_downlink("explode")


def test_diagnostic_is_not_mistaken_for_capability_discovery():
    """A diagnostic downlink must never trip the capability auto-responder."""
    for command in iot.DIAG_COMMANDS:
        payload = iot.sid_demo_diagnostic_downlink(command)
        assert not iot._is_capability_discovery_notify(payload)
