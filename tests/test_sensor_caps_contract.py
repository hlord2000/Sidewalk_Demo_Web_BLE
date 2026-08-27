"""Guards the sensor capability bitmask shared by firmware and frontend.

The firmware emits `caps` in its telemetry JSON and static/sensors.js decides
which cards to show from it. The two must agree on the bit values, so pin them
here: changing a bit on one side without the other silently mislabels boards.
"""

import re
from pathlib import Path

SENSORS_JS = Path(__file__).resolve().parent.parent / "static" / "sensors.js"

EXPECTED_BITS = {
    "CAP_TEMPERATURE": 1,
    "CAP_HUMIDITY": 2,
    "CAP_ACCEL": 4,
    "CAP_BATTERY": 8,
}


def _source() -> str:
    return SENSORS_JS.read_text(encoding="utf-8")


def test_capability_bits_match_firmware_contract():
    source = _source()
    for name, value in EXPECTED_BITS.items():
        match = re.search(rf"\bconst {name} = (\d+);", source)
        assert match, f"{name} is missing from sensors.js"
        assert int(match.group(1)) == value, (
            f"{name} is {match.group(1)} in sensors.js but the firmware sends {value}"
        )


def test_caps_is_read_from_telemetry_payload():
    source = _source()
    assert '"caps",' in source, "caps must be listed in TELEMETRY_KEYS"
    assert "num(pj.caps)" in source, "caps must be parsed off payload_json"


def test_every_sensor_card_declares_a_capability():
    """A card with no `cap` can never be hidden, so it would stay blank forever."""
    source = _source()
    for card_id in ("temperature", "humidity", "battery", "voltage", "accel", "current"):
        assert re.search(rf'id: "{card_id}",\s*\n\s*cap: CAP_', source), (
            f'chart "{card_id}" does not declare a cap'
        )
    stats = re.search(r"const STAT_DEFS = \[(.*?)\n  \];", source, re.S)
    assert stats, "STAT_DEFS not found"
    for line in stats.group(1).strip().splitlines():
        line = line.strip()
        if line.startswith("{ id:"):
            assert "cap: CAP_" in line, f"stat tile without a cap: {line}"
