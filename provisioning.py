from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from typing import Any


MFG_STORAGE_ADDRESS = 0x162000
MFG_VERSION_TLV = 8
SMSN_SIZE = 32
SERIAL_SIZE_WITHOUT_EXPANSION = 4
PRK_SIZE = 32
ED25519_PUB_SIZE = 32
P256R1_PUB_SIZE = 64
SIG_SIZE = 64


class ProvisioningError(ValueError):
    pass


@dataclass
class CertChain:
    device_serial: bytes
    device_pub: bytes
    device_sig: bytes
    dak_serial: bytes
    dak_pub: bytes
    dak_sig: bytes
    product_serial: bytes
    product_pub: bytes
    product_sig: bytes
    man_serial: bytes
    man_pub: bytes
    man_sig: bytes
    sw_serial: bytes
    sw_pub: bytes
    sw_sig: bytes
    root_serial: bytes
    root_pub: bytes
    root_sig: bytes
    device_prk: bytes


def _hex_to_bytes(value: str, field_name: str) -> bytes:
    try:
        return binascii.unhexlify(value)
    except (binascii.Error, TypeError) as exc:
        raise ProvisioningError(f"{field_name} must be a hex string") from exc


def _expect_length(value: bytes, expected: int, field_name: str) -> bytes:
    if len(value) != expected:
        raise ProvisioningError(f"{field_name} must be {expected} bytes")
    return value


def _get_signing_value(items: list[dict[str, Any]] | None, alg: str, field_name: str) -> str:
    for item in items or []:
        if item.get("SigningAlg") == alg:
            value = item.get("Value")
            if value:
                return value
    raise ProvisioningError(f"Missing {field_name} for {alg}")


def _serial_length(data: bytes) -> int:
    if len(data) < SERIAL_SIZE_WITHOUT_EXPANSION:
        raise ProvisioningError("Certificate chain is too short for serial field")
    serial_header = int.from_bytes(data[:SERIAL_SIZE_WITHOUT_EXPANSION], "little")
    if serial_header & 0xF0000000 == 0xB0000000:
        return ((serial_header >> 16) & 0x7F) + 2
    return SERIAL_SIZE_WITHOUT_EXPANSION


def _split(data: bytes, length: int, field_name: str) -> tuple[bytes, bytes]:
    if len(data) < length:
        raise ProvisioningError(f"Certificate chain is too short for {field_name}")
    return data[:length], data[length:]


def _parse_cert_chain(cert_b64: str, private_key_hex: str, public_key_size: int, name: str) -> CertChain:
    try:
        data = base64.b64decode(cert_b64)
    except (binascii.Error, TypeError) as exc:
        raise ProvisioningError(f"{name} certificate chain must be base64") from exc

    private_key = bytearray(_hex_to_bytes(private_key_hex, f"{name} private key"))
    if public_key_size == P256R1_PUB_SIZE and len(private_key) == PRK_SIZE + 1 and private_key[0] == 0:
        del private_key[0]
    if len(private_key) != PRK_SIZE:
        raise ProvisioningError(f"{name} private key must be {PRK_SIZE} bytes")

    fields: dict[str, bytes] = {}
    for cert_name in ("device", "dak", "product", "man", "sw", "root"):
        serial_len = SMSN_SIZE if cert_name == "device" else _serial_length(data)
        serial, data = _split(data, serial_len, f"{name} {cert_name} serial")
        pub, data = _split(data, public_key_size, f"{name} {cert_name} public key")
        sig, data = _split(data, SIG_SIZE, f"{name} {cert_name} signature")
        fields[f"{cert_name}_serial"] = serial
        fields[f"{cert_name}_pub"] = pub
        fields[f"{cert_name}_sig"] = sig

    if data:
        raise ProvisioningError(f"{name} certificate chain has trailing data")

    return CertChain(**fields, device_prk=bytes(private_key))


def _device_type_id(device_profile_json: dict[str, Any]) -> str:
    sidewalk = device_profile_json.get("Sidewalk") or {}
    metadata = (
        sidewalk.get("DakCertificateMetadata")
        or sidewalk.get("DAKCertificateMetadata")
        or sidewalk.get("DAKCertificate")
        or []
    )
    for item in metadata:
        device_type_id = item.get("DeviceTypeId")
        if device_type_id:
            return device_type_id[-4:]
    apid = sidewalk.get("ApId")
    if apid:
        return str(apid)
    raise ProvisioningError("Device profile is missing DeviceTypeId/ApId")


def _tlv(tag: int, data: bytes) -> bytes:
    record = tag.to_bytes(2, "big") + len(data).to_bytes(2, "big") + data
    return record + (b"\xff" * ((4 - (len(record) % 4)) % 4))


# Wire contract shared with firmware: these numeric ids and byte lengths are
# sid_pal_mfg_store_value_t values from
# sidewalk/subsys/sal/common/sid_pal_ifc/sid_pal_mfg_store_ifc.h. Cross-checked
# against that header on 2026-08-20: every id/size pair below matches it
# exactly. Tags 36/37 are named "root_*" in CertChain (Amazon's root CA role
# in the chain) but the header calls the same two values AMZN_PUB_ED25519 and
# AMZN_PUB_P256R1; that is a naming difference only, not a disagreement.
MFG_STORE_VALUES = (
    (4, "SID_PAL_MFG_STORE_SMSN", SMSN_SIZE),
    (5, "SID_PAL_MFG_STORE_APP_PUB_ED25519", ED25519_PUB_SIZE),
    (6, "SID_PAL_MFG_STORE_DEVICE_PRIV_ED25519", PRK_SIZE),
    (7, "SID_PAL_MFG_STORE_DEVICE_PUB_ED25519", ED25519_PUB_SIZE),
    (8, "SID_PAL_MFG_STORE_DEVICE_PUB_ED25519_SIGNATURE", SIG_SIZE),
    (9, "SID_PAL_MFG_STORE_DEVICE_PRIV_P256R1", PRK_SIZE),
    (10, "SID_PAL_MFG_STORE_DEVICE_PUB_P256R1", P256R1_PUB_SIZE),
    (11, "SID_PAL_MFG_STORE_DEVICE_PUB_P256R1_SIGNATURE", SIG_SIZE),
    (12, "SID_PAL_MFG_STORE_DAK_PUB_ED25519", ED25519_PUB_SIZE),
    (13, "SID_PAL_MFG_STORE_DAK_PUB_ED25519_SIGNATURE", SIG_SIZE),
    (14, "SID_PAL_MFG_STORE_DAK_ED25519_SERIAL", SERIAL_SIZE_WITHOUT_EXPANSION),
    (15, "SID_PAL_MFG_STORE_DAK_PUB_P256R1", P256R1_PUB_SIZE),
    (16, "SID_PAL_MFG_STORE_DAK_PUB_P256R1_SIGNATURE", SIG_SIZE),
    (17, "SID_PAL_MFG_STORE_DAK_P256R1_SERIAL", SERIAL_SIZE_WITHOUT_EXPANSION),
    (18, "SID_PAL_MFG_STORE_PRODUCT_PUB_ED25519", ED25519_PUB_SIZE),
    (19, "SID_PAL_MFG_STORE_PRODUCT_PUB_ED25519_SIGNATURE", SIG_SIZE),
    (20, "SID_PAL_MFG_STORE_PRODUCT_ED25519_SERIAL", SERIAL_SIZE_WITHOUT_EXPANSION),
    (21, "SID_PAL_MFG_STORE_PRODUCT_PUB_P256R1", P256R1_PUB_SIZE),
    (22, "SID_PAL_MFG_STORE_PRODUCT_PUB_P256R1_SIGNATURE", SIG_SIZE),
    (23, "SID_PAL_MFG_STORE_PRODUCT_P256R1_SERIAL", SERIAL_SIZE_WITHOUT_EXPANSION),
    (24, "SID_PAL_MFG_STORE_MAN_PUB_ED25519", ED25519_PUB_SIZE),
    (25, "SID_PAL_MFG_STORE_MAN_PUB_ED25519_SIGNATURE", SIG_SIZE),
    (26, "SID_PAL_MFG_STORE_MAN_ED25519_SERIAL", SERIAL_SIZE_WITHOUT_EXPANSION),
    (27, "SID_PAL_MFG_STORE_MAN_PUB_P256R1", P256R1_PUB_SIZE),
    (28, "SID_PAL_MFG_STORE_MAN_PUB_P256R1_SIGNATURE", SIG_SIZE),
    (29, "SID_PAL_MFG_STORE_MAN_P256R1_SERIAL", SERIAL_SIZE_WITHOUT_EXPANSION),
    (30, "SID_PAL_MFG_STORE_SW_PUB_ED25519", ED25519_PUB_SIZE),
    (31, "SID_PAL_MFG_STORE_SW_PUB_ED25519_SIGNATURE", SIG_SIZE),
    (32, "SID_PAL_MFG_STORE_SW_ED25519_SERIAL", SERIAL_SIZE_WITHOUT_EXPANSION),
    (33, "SID_PAL_MFG_STORE_SW_PUB_P256R1", P256R1_PUB_SIZE),
    (34, "SID_PAL_MFG_STORE_SW_PUB_P256R1_SIGNATURE", SIG_SIZE),
    (35, "SID_PAL_MFG_STORE_SW_P256R1_SERIAL", SERIAL_SIZE_WITHOUT_EXPANSION),
    (36, "SID_PAL_MFG_STORE_AMZN_PUB_ED25519", ED25519_PUB_SIZE),
    (37, "SID_PAL_MFG_STORE_AMZN_PUB_P256R1", P256R1_PUB_SIZE),
    (38, "SID_PAL_MFG_STORE_APID", 4),
)
MFG_STORE_VALUE_NAMES: dict[int, str] = {value_id: name for value_id, name, _size in MFG_STORE_VALUES}
MFG_STORE_VALUE_SIZES: dict[int, int] = {value_id: size for value_id, _name, size in MFG_STORE_VALUES}


def mfg_store_values(wireless_device_json: dict[str, Any], device_profile_json: dict[str, Any]) -> dict[int, bytes]:
    """Decompose device artifacts into sid_pal_mfg_store_value_t id -> bytes.

    Single place that turns the AWS get_wireless_device/get_device_profile
    shape into individual manufacturing values. build_sidewalk_mfg_bin() and
    the BLE NUS per-value provisioning endpoint both consume this instead of
    each parsing the certificate chain themselves.
    """
    sidewalk_device = wireless_device_json.get("Sidewalk") or {}
    sidewalk_profile = device_profile_json.get("Sidewalk") or {}

    ed25519 = _parse_cert_chain(
        _get_signing_value(sidewalk_device.get("DeviceCertificates"), "Ed25519", "device certificate"),
        _get_signing_value(sidewalk_device.get("PrivateKeys"), "Ed25519", "private key"),
        ED25519_PUB_SIZE,
        "Ed25519",
    )
    p256r1 = _parse_cert_chain(
        _get_signing_value(sidewalk_device.get("DeviceCertificates"), "P256r1", "device certificate"),
        _get_signing_value(sidewalk_device.get("PrivateKeys"), "P256r1", "private key"),
        P256R1_PUB_SIZE,
        "P256r1",
    )

    smsn = _expect_length(
        _hex_to_bytes(sidewalk_device.get("SidewalkManufacturingSn", ""), "SidewalkManufacturingSn"),
        SMSN_SIZE,
        "SidewalkManufacturingSn",
    )
    app_pub = _expect_length(
        _hex_to_bytes(sidewalk_profile.get("ApplicationServerPublicKey", ""), "ApplicationServerPublicKey"),
        ED25519_PUB_SIZE,
        "ApplicationServerPublicKey",
    )
    apid = _device_type_id(device_profile_json).encode("ascii")
    _expect_length(apid, 4, "DeviceTypeId/ApId")

    return {
        4: smsn,
        5: app_pub,
        6: ed25519.device_prk,
        7: ed25519.device_pub,
        8: ed25519.device_sig,
        9: p256r1.device_prk,
        10: p256r1.device_pub,
        11: p256r1.device_sig,
        12: ed25519.dak_pub,
        13: ed25519.dak_sig,
        14: ed25519.dak_serial,
        15: p256r1.dak_pub,
        16: p256r1.dak_sig,
        17: p256r1.dak_serial,
        18: ed25519.product_pub,
        19: ed25519.product_sig,
        20: ed25519.product_serial,
        21: p256r1.product_pub,
        22: p256r1.product_sig,
        23: p256r1.product_serial,
        24: ed25519.man_pub,
        25: ed25519.man_sig,
        26: ed25519.man_serial,
        27: p256r1.man_pub,
        28: p256r1.man_sig,
        29: p256r1.man_serial,
        30: ed25519.sw_pub,
        31: ed25519.sw_sig,
        32: ed25519.sw_serial,
        33: p256r1.sw_pub,
        34: p256r1.sw_sig,
        35: p256r1.sw_serial,
        36: ed25519.root_pub,
        37: p256r1.root_pub,
        38: apid,
    }


def build_sidewalk_mfg_bin(wireless_device_json: dict[str, Any], device_profile_json: dict[str, Any]) -> bytes:
    values = mfg_store_values(wireless_device_json, device_profile_json)

    output = bytearray(b"SID0")
    output.extend(MFG_VERSION_TLV.to_bytes(4, "big"))
    for tag in sorted(values):
        output.extend(_tlv(tag, values[tag]))
    return bytes(output)


def normalize_smsn(raw_smsn: Any) -> str:
    """Return the 64 hex char Sidewalk manufacturing serial, or "" if absent/invalid."""
    if not isinstance(raw_smsn, str):
        return ""
    compact = "".join(character for character in raw_smsn if character not in ":- \t\r\n")
    if len(compact) != SMSN_SIZE * 2:
        return ""
    try:
        bytes.fromhex(compact)
    except ValueError:
        return ""
    return compact.upper()


def device_sidewalk_smsn(
    wireless_device_json: dict[str, Any] | None,
    provisioning_json: dict[str, Any] | None,
) -> str:
    """Extract the SMSN from whichever device artifact happens to carry it.

    Shared by app.py (dashboard identity) and memfault.py (chunk device serial)
    so there is exactly one place that knows where the SMSN can hide.
    """
    wireless_device_json = wireless_device_json or {}
    provisioning_json = provisioning_json or {}
    raw_smsn = (
        (wireless_device_json.get("Sidewalk") or {}).get("SidewalkManufacturingSn")
        or (provisioning_json.get("metadata") or {}).get("smsn")
        or ""
    )
    return normalize_smsn(raw_smsn)


def build_provisioning_commands(mfg_values: dict[int, bytes], max_fragment_bytes: int) -> list[str]:
    """Build the ordered NUS shell command script that writes each mfg value.

    Grammar confirmed against the firmware: prov_status.c declares
    CMD_PROV_SET_ARG_REQUIRED 5 with CMD_PROV_SET_ARG_OPTIONAL 0, and Zephyr
    counts the subcommand word in argc, so "set" plus exactly four arguments
    is accepted. frag_index is therefore mandatory and is always emitted,
    including for values that fit in a single fragment.

    Firmware flow, one sid_pal_mfg_store_write() call per value:
        prov erase
        prov set <value_id> <total_len> <frag_index> <base64>
        prov finalize
        prov reboot
    The firmware reports progress and outcome asynchronously over the same
    NUS shell as EVT:{"t":"provwr","id":<value_id>,"ok":<bool>} and
    EVT:{"t":"provdone","ok":<bool>,"err":"..."} lines, which reach this
    backend through the existing BLE log ingest.
    """
    if max_fragment_bytes <= 0:
        raise ProvisioningError("max_fragment_bytes must be positive")

    commands = ["prov erase"]
    for value_id in sorted(mfg_values):
        value = mfg_values[value_id]
        total_len = len(value)
        offsets = list(range(0, total_len, max_fragment_bytes)) or [0]
        fragments = [value[offset : offset + max_fragment_bytes] for offset in offsets]
        for frag_index, fragment in enumerate(fragments):
            encoded = base64.b64encode(fragment).decode("ascii")
            commands.append(f"prov set {value_id} {total_len} {frag_index} {encoded}")
    commands.append("prov finalize")
    commands.append("prov reboot")
    return commands


CERTIFICATE_JSON_TOP_KEYS = ("p256R1", "eD25519", "applicationServerPublicKey", "metadata")
CERTIFICATE_JSON_METADATA_KEYS = (
    "deviceTypeId",
    "applicationDeviceArn",
    "applicationDeviceId",
    "smsn",
    "devicePrivKeyP256R1",
    "devicePrivKeyEd25519",
)


def validate_certificate_json(data: Any) -> dict[str, Any]:
    """Validate an AWS IoT Wireless console ``certificate.json`` export.

    Only presence and byte length of the private key fields are checked; the
    values themselves are never logged or included in any error message.
    """
    if not isinstance(data, dict):
        raise ProvisioningError("certificate.json must be a JSON object")

    for key in CERTIFICATE_JSON_TOP_KEYS:
        if key not in data:
            raise ProvisioningError(f"certificate.json is missing '{key}'")

    metadata = data.get("metadata")
    if not isinstance(metadata, dict):
        raise ProvisioningError("certificate.json 'metadata' must be an object")
    for key in CERTIFICATE_JSON_METADATA_KEYS:
        if not metadata.get(key):
            raise ProvisioningError(f"certificate.json metadata is missing '{key}'")

    for cert_field in ("p256R1", "eD25519"):
        value = data.get(cert_field)
        if not isinstance(value, str) or not value:
            raise ProvisioningError(f"certificate.json '{cert_field}' must be a non-empty base64 string")
        try:
            base64.b64decode(value, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ProvisioningError(f"certificate.json '{cert_field}' must be valid base64") from exc

    _expect_length(
        _hex_to_bytes(data.get("applicationServerPublicKey", ""), "applicationServerPublicKey"),
        ED25519_PUB_SIZE,
        "applicationServerPublicKey",
    )
    _expect_length(_hex_to_bytes(metadata.get("smsn", ""), "metadata.smsn"), SMSN_SIZE, "metadata.smsn")

    for priv_field in ("devicePrivKeyP256R1", "devicePrivKeyEd25519"):
        key_bytes = _hex_to_bytes(metadata.get(priv_field, ""), f"metadata.{priv_field}")
        if len(key_bytes) not in (PRK_SIZE, PRK_SIZE + 1):
            raise ProvisioningError(f"metadata '{priv_field}' must be {PRK_SIZE} or {PRK_SIZE + 1} bytes")

    device_type_id = metadata.get("deviceTypeId")
    if not isinstance(device_type_id, str) or len(device_type_id) < 4:
        raise ProvisioningError("metadata 'deviceTypeId' must be at least 4 characters")

    return data


def wireless_device_json_from_certificate_json(cert_json: dict[str, Any]) -> dict[str, Any]:
    """Adapt an ACS-console certificate.json into the AWS get_wireless_device shape.

    build_sidewalk_mfg_bin() only knows the AWS get_wireless_device/get_device_profile
    shape, so this reshapes the console export to match instead of adding a second
    TLV builder for the same manufacturing page.
    """
    metadata = cert_json.get("metadata") or {}
    return {
        "Id": metadata.get("applicationDeviceId", ""),
        "Arn": metadata.get("applicationDeviceArn", ""),
        "Sidewalk": {
            "SidewalkManufacturingSn": metadata.get("smsn", ""),
            "DeviceCertificates": [
                {"SigningAlg": "Ed25519", "Value": cert_json.get("eD25519", "")},
                {"SigningAlg": "P256r1", "Value": cert_json.get("p256R1", "")},
            ],
            "PrivateKeys": [
                {"SigningAlg": "Ed25519", "Value": metadata.get("devicePrivKeyEd25519", "")},
                {"SigningAlg": "P256r1", "Value": metadata.get("devicePrivKeyP256R1", "")},
            ],
        },
    }


def device_profile_json_from_certificate_json(cert_json: dict[str, Any]) -> dict[str, Any]:
    """Adapt an ACS-console certificate.json into the AWS get_device_profile shape."""
    device_type_id = (cert_json.get("metadata") or {}).get("deviceTypeId", "")
    return {
        "Sidewalk": {
            "ApplicationServerPublicKey": cert_json.get("applicationServerPublicKey", ""),
            "DakCertificateMetadata": [{"DeviceTypeId": device_type_id}] if device_type_id else [],
        }
    }


def _checksum(record: list[int]) -> int:
    return ((~sum(record) + 1) & 0xFF)


def _hex_record(address: int, record_type: int, data: bytes = b"") -> str:
    payload = [len(data), (address >> 8) & 0xFF, address & 0xFF, record_type, *data]
    return ":" + "".join(f"{byte:02X}" for byte in [*payload, _checksum(payload)])


def bytes_to_ihex(data: bytes, address: int = MFG_STORAGE_ADDRESS) -> str:
    lines = []
    current_upper = None
    offset = 0

    while offset < len(data):
        absolute = address + offset
        upper = (absolute >> 16) & 0xFFFF
        if upper != current_upper:
            lines.append(_hex_record(0, 0x04, upper.to_bytes(2, "big")))
            current_upper = upper

        chunk = data[offset : offset + 16]
        lines.append(_hex_record(absolute & 0xFFFF, 0x00, chunk))
        offset += len(chunk)

    lines.append(_hex_record(0, 0x01))
    return "\n".join(lines) + "\n"


def _parse_ihex(text: str) -> dict[int, int]:
    memory: dict[int, int] = {}
    upper_linear = 0
    upper_segment = 0

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if not line.startswith(":"):
            raise ProvisioningError("Invalid Intel HEX record")

        values = bytes.fromhex(line[1:])
        count = values[0]
        address = (values[1] << 8) | values[2]
        record_type = values[3]
        data = values[4 : 4 + count]
        if _checksum(list(values[:-1])) != values[-1]:
            raise ProvisioningError("Intel HEX checksum mismatch")

        if record_type == 0x00:
            base = (upper_linear << 16) if upper_linear else (upper_segment << 4)
            for index, value in enumerate(data):
                memory[base + address + index] = value
        elif record_type == 0x01:
            break
        elif record_type == 0x02:
            upper_segment = int.from_bytes(data, "big")
            upper_linear = 0
        elif record_type == 0x04:
            upper_linear = int.from_bytes(data, "big")
            upper_segment = 0

    return memory


def merge_ihex(base_hex: str, overlay_hex: str) -> str:
    memory = _parse_ihex(base_hex)
    memory.update(_parse_ihex(overlay_hex))
    if not memory:
        return _hex_record(0, 0x01) + "\n"

    lines = []
    current_upper = None
    addresses = sorted(memory)
    index = 0
    while index < len(addresses):
        start = addresses[index]
        chunk = bytearray([memory[start]])
        index += 1
        while (
            index < len(addresses)
            and addresses[index] == start + len(chunk)
            and len(chunk) < 16
            and (addresses[index] >> 16) == (start >> 16)
        ):
            chunk.append(memory[addresses[index]])
            index += 1

        upper = (start >> 16) & 0xFFFF
        if upper != current_upper:
            lines.append(_hex_record(0, 0x04, upper.to_bytes(2, "big")))
            current_upper = upper
        lines.append(_hex_record(start & 0xFFFF, 0x00, bytes(chunk)))

    lines.append(_hex_record(0, 0x01))
    return "\n".join(lines) + "\n"
