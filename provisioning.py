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


def build_sidewalk_mfg_bin(wireless_device_json: dict[str, Any], device_profile_json: dict[str, Any]) -> bytes:
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

    records = [
        (4, smsn),
        (5, app_pub),
        (6, ed25519.device_prk),
        (7, ed25519.device_pub),
        (8, ed25519.device_sig),
        (9, p256r1.device_prk),
        (10, p256r1.device_pub),
        (11, p256r1.device_sig),
        (12, ed25519.dak_pub),
        (13, ed25519.dak_sig),
        (14, ed25519.dak_serial),
        (15, p256r1.dak_pub),
        (16, p256r1.dak_sig),
        (17, p256r1.dak_serial),
        (18, ed25519.product_pub),
        (19, ed25519.product_sig),
        (20, ed25519.product_serial),
        (21, p256r1.product_pub),
        (22, p256r1.product_sig),
        (23, p256r1.product_serial),
        (24, ed25519.man_pub),
        (25, ed25519.man_sig),
        (26, ed25519.man_serial),
        (27, p256r1.man_pub),
        (28, p256r1.man_sig),
        (29, p256r1.man_serial),
        (30, ed25519.sw_pub),
        (31, ed25519.sw_sig),
        (32, ed25519.sw_serial),
        (33, p256r1.sw_pub),
        (34, p256r1.sw_sig),
        (35, p256r1.sw_serial),
        (36, ed25519.root_pub),
        (37, p256r1.root_pub),
        (38, apid),
    ]

    output = bytearray(b"SID0")
    output.extend(MFG_VERSION_TLV.to_bytes(4, "big"))
    for tag, value in sorted(records, key=lambda item: item[0]):
        output.extend(_tlv(tag, value))
    return bytes(output)


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
