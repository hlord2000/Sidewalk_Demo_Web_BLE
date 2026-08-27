"""Tests for the certificate.json validator and the per-value/command-script builders.

Fixtures are generated at test time with secrets.token_bytes/base64 instead of
pasted literals, so field lengths are correct by construction.
"""

import base64
import secrets
import unittest

from provisioning import (
    MFG_STORE_VALUE_SIZES,
    ProvisioningError,
    build_provisioning_commands,
    device_profile_json_from_certificate_json,
    validate_certificate_json,
    wireless_device_json_from_certificate_json,
)


def _valid_certificate_json() -> dict:
    return {
        "p256R1": base64.b64encode(secrets.token_bytes(64)).decode("ascii"),
        "eD25519": base64.b64encode(secrets.token_bytes(64)).decode("ascii"),
        "applicationServerPublicKey": secrets.token_bytes(32).hex(),
        "metadata": {
            "deviceTypeId": "ab12",
            "applicationDeviceArn": "arn:aws:iotwireless:us-east-1:123456789012:WirelessDevice/abc",
            "applicationDeviceId": "abc-123",
            "smsn": secrets.token_bytes(32).hex(),
            "devicePrivKeyP256R1": secrets.token_bytes(32).hex(),
            "devicePrivKeyEd25519": secrets.token_bytes(32).hex(),
        },
    }


class CertificateJsonValidatorTests(unittest.TestCase):
    def test_a_well_formed_export_is_accepted(self) -> None:
        data = _valid_certificate_json()

        validate_certificate_json(data)  # should not raise

    def test_rejects_a_non_object_payload(self) -> None:
        with self.assertRaises(ProvisioningError):
            validate_certificate_json(["not", "an", "object"])

    def test_rejects_a_missing_top_level_key(self) -> None:
        data = _valid_certificate_json()
        del data["eD25519"]

        with self.assertRaises(ProvisioningError):
            validate_certificate_json(data)

    def test_rejects_a_missing_metadata_key(self) -> None:
        data = _valid_certificate_json()
        del data["metadata"]["smsn"]

        with self.assertRaises(ProvisioningError):
            validate_certificate_json(data)

    def test_rejects_non_base64_certificate_chain(self) -> None:
        data = _valid_certificate_json()
        data["p256R1"] = "not base64 at all!!"

        with self.assertRaises(ProvisioningError):
            validate_certificate_json(data)

    def test_rejects_wrong_length_application_server_public_key(self) -> None:
        data = _valid_certificate_json()
        data["applicationServerPublicKey"] = secrets.token_bytes(16).hex()

        with self.assertRaises(ProvisioningError):
            validate_certificate_json(data)

    def test_rejects_wrong_length_smsn(self) -> None:
        data = _valid_certificate_json()
        data["metadata"]["smsn"] = secrets.token_bytes(31).hex()

        with self.assertRaises(ProvisioningError):
            validate_certificate_json(data)

    def test_rejects_a_private_key_that_is_not_hex(self) -> None:
        data = _valid_certificate_json()
        data["metadata"]["devicePrivKeyEd25519"] = "zz" * 32

        with self.assertRaises(ProvisioningError):
            validate_certificate_json(data)

    def test_rejects_a_short_device_type_id(self) -> None:
        data = _valid_certificate_json()
        data["metadata"]["deviceTypeId"] = "abc"

        with self.assertRaises(ProvisioningError):
            validate_certificate_json(data)

    def test_never_raises_with_the_private_key_value_in_the_message(self) -> None:
        data = _valid_certificate_json()
        secret_value = data["metadata"]["devicePrivKeyEd25519"]
        data["metadata"]["devicePrivKeyEd25519"] = "not-hex"

        with self.assertRaises(ProvisioningError) as ctx:
            validate_certificate_json(data)

        self.assertNotIn(secret_value, str(ctx.exception))


class CertificateJsonAdapterTests(unittest.TestCase):
    def test_adapts_into_the_aws_get_wireless_device_shape(self) -> None:
        data = _valid_certificate_json()

        wireless_device_json = wireless_device_json_from_certificate_json(data)

        sidewalk = wireless_device_json["Sidewalk"]
        self.assertEqual(sidewalk["SidewalkManufacturingSn"], data["metadata"]["smsn"])
        certs_by_alg = {c["SigningAlg"]: c["Value"] for c in sidewalk["DeviceCertificates"]}
        self.assertEqual(certs_by_alg["Ed25519"], data["eD25519"])
        self.assertEqual(certs_by_alg["P256r1"], data["p256R1"])
        keys_by_alg = {k["SigningAlg"]: k["Value"] for k in sidewalk["PrivateKeys"]}
        self.assertEqual(keys_by_alg["Ed25519"], data["metadata"]["devicePrivKeyEd25519"])
        self.assertEqual(keys_by_alg["P256r1"], data["metadata"]["devicePrivKeyP256R1"])

    def test_adapts_into_the_aws_get_device_profile_shape(self) -> None:
        data = _valid_certificate_json()

        device_profile_json = device_profile_json_from_certificate_json(data)

        sidewalk = device_profile_json["Sidewalk"]
        self.assertEqual(sidewalk["ApplicationServerPublicKey"], data["applicationServerPublicKey"])
        self.assertEqual(sidewalk["DakCertificateMetadata"][0]["DeviceTypeId"], data["metadata"]["deviceTypeId"])


class ProvisioningCommandScriptTests(unittest.TestCase):
    def test_starts_with_erase_and_ends_with_finalize_reboot(self) -> None:
        values = {4: secrets.token_bytes(MFG_STORE_VALUE_SIZES[4])}

        commands = build_provisioning_commands(values, max_fragment_bytes=64)

        self.assertEqual(commands[0], "prov erase")
        self.assertEqual(commands[-2], "prov finalize")
        self.assertEqual(commands[-1], "prov reboot")

    def test_a_value_within_the_fragment_budget_still_carries_frag_index_zero(self) -> None:
        value = secrets.token_bytes(32)
        values = {4: value}

        commands = build_provisioning_commands(values, max_fragment_bytes=64)

        set_commands = [c for c in commands if c.startswith("prov set")]
        self.assertEqual(len(set_commands), 1)
        parts = set_commands[0].split(" ")
        self.assertEqual(parts[:3], ["prov", "set", "4"])
        self.assertEqual(parts[3], str(len(value)))
        # frag_index is mandatory in the firmware grammar, so a single-fragment
        # value still sends index 0. prov_status.c sets CMD_PROV_SET_ARG_REQUIRED
        # to 5 with 0 optional args, and Zephyr counts the subcommand word in
        # argc, so anything but "set" plus four arguments is rejected.
        self.assertEqual(len(parts), 6)
        self.assertEqual(parts[4], "0")
        self.assertEqual(base64.b64decode(parts[5]), value)

    def test_every_set_command_has_the_arg_count_the_firmware_requires(self) -> None:
        values = {4: secrets.token_bytes(32), 10: secrets.token_bytes(64)}

        commands = build_provisioning_commands(values, max_fragment_bytes=64)

        for command in (c for c in commands if c.startswith("prov set")):
            # argc as Zephyr counts it: the "set" word plus four arguments.
            self.assertEqual(len(command.split(" ")) - 1, 5, command)

    def test_a_value_over_the_fragment_budget_splits_with_frag_index_and_reassembles(self) -> None:
        value = secrets.token_bytes(40)
        values = {9: value}

        commands = build_provisioning_commands(values, max_fragment_bytes=16)

        set_commands = [c for c in commands if c.startswith("prov set")]
        self.assertEqual(len(set_commands), 3)  # 16 + 16 + 8
        reassembled = bytearray()
        for frag_index, command in enumerate(set_commands):
            parts = command.split(" ")
            self.assertEqual(parts[:3], ["prov", "set", "9"])
            self.assertEqual(parts[3], str(len(value)))
            self.assertEqual(parts[4], str(frag_index))
            reassembled.extend(base64.b64decode(parts[5]))
        self.assertEqual(bytes(reassembled), value)

    def test_multiple_values_are_emitted_in_ascending_value_id_order(self) -> None:
        values = {38: b"abcd", 4: secrets.token_bytes(32), 10: secrets.token_bytes(64)}

        commands = build_provisioning_commands(values, max_fragment_bytes=64)

        set_ids = [int(c.split(" ")[2]) for c in commands if c.startswith("prov set")]
        self.assertEqual(set_ids, sorted(values))

    def test_rejects_a_non_positive_fragment_size(self) -> None:
        with self.assertRaises(ProvisioningError):
            build_provisioning_commands({4: b"\x01"}, max_fragment_bytes=0)


if __name__ == "__main__":
    unittest.main()
