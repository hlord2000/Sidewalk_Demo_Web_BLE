from __future__ import annotations

import base64
import json
import logging
import queue
import threading
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable
from uuid import uuid4

try:
    import boto3
except ImportError:  # pragma: no cover - handled at runtime
    boto3 = None

try:
    from awscrt import auth, io, mqtt
    from awsiot import mqtt_connection_builder
except ImportError:  # pragma: no cover - handled at runtime
    auth = None
    io = None
    mqtt = None
    mqtt_connection_builder = None


LOGGER = logging.getLogger(__name__)

MESSAGE_TYPE_NOTIFY = "CUSTOM_COMMAND_ID_NOTIFY"
PLACEHOLDER_PREFIX = "REPLACE_"

# Tag byte firmware prefixes onto a Memfault SDK packetizer chunk before
# sending it as a Sidewalk uplink. See _memfault_chunk_from_payload.
MEMFAULT_CHUNK_TAG = 0xC0


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _is_printable_ascii(data: bytes) -> bool:
    return all(32 <= b <= 126 or b in (9, 10, 13) for b in data)


def _is_hex_ascii(text: str) -> bool:
    if not text or (len(text) % 2) != 0:
        return False
    return all(ch in "0123456789abcdefABCDEF" for ch in text)


def _memfault_chunk_from_payload(raw_bytes: bytes) -> tuple[int, bytes] | None:
    """Detect a Memfault chunk uplink on the RAW decoded payload bytes.

    Wire format: byte 0 is the 0xC0 tag, byte 1 is a wrapping sequence number
    (diagnostics only), the rest is the Memfault chunk to forward verbatim.
    Must run before any printable-ASCII/hex heuristics in
    _decode_nested_payload, which would otherwise mangle a binary chunk.

    Real Sidewalk uplinks arrive double-encoded: the payload is an ASCII hex
    string of the bytes the firmware sent, so a chunk shows up as the text
    "c005..." rather than the bytes 0xC0 0x05. Unwrap that first, otherwise the
    tag check compares against ASCII 'c' (0x63) and never matches. Synthetic
    test messages that carry raw bytes still work, so both forms are accepted.
    """
    if len(raw_bytes) >= 4 and _is_printable_ascii(raw_bytes):
        text = raw_bytes.decode("ascii", errors="ignore")
        if _is_hex_ascii(text):
            try:
                raw_bytes = bytes.fromhex(text)
            except ValueError:
                pass

    if len(raw_bytes) < 2 or raw_bytes[0] != MEMFAULT_CHUNK_TAG:
        return None
    return raw_bytes[1], raw_bytes[2:]


def _decode_nested_payload(decoded_bytes: bytes) -> tuple[bytes, str, dict[str, Any] | None]:
    decoded_text = ""
    payload_json = None

    if not decoded_bytes or not _is_printable_ascii(decoded_bytes):
        return decoded_bytes, decoded_text, payload_json

    decoded_text = decoded_bytes.decode("utf-8", errors="replace")

    if _is_hex_ascii(decoded_text):
        try:
            nested_bytes = bytes.fromhex(decoded_text)
        except ValueError:
            nested_bytes = b""
        if nested_bytes and _is_printable_ascii(nested_bytes):
            decoded_bytes = nested_bytes
            decoded_text = nested_bytes.decode("utf-8", errors="replace")

    if decoded_text.startswith("{"):
        try:
            payload_json = json.loads(decoded_text)
        except json.JSONDecodeError:
            payload_json = None

    return decoded_bytes, decoded_text, payload_json


def _link_name(link_type: Any) -> str:
    names = {
        1: "BLE",
        2: "FSK",
        3: "LoRa",
        "BLE": "BLE",
        "FSK": "FSK",
        "LoRa": "LoRa",
    }
    return names.get(link_type, str(link_type))


def _location_event(message: Any, topic: str) -> dict[str, Any] | None:
    if not isinstance(message, dict) or message.get("type") != "Point":
        return None

    coordinates = message.get("coordinates")
    wireless_device_id = message.get("WirelessDeviceId")
    if (
        not isinstance(coordinates, list)
        or len(coordinates) < 2
        or not isinstance(wireless_device_id, str)
        or not wireless_device_id
    ):
        return None

    longitude, latitude = coordinates[:2]
    if (
        isinstance(longitude, bool)
        or isinstance(latitude, bool)
        or not isinstance(longitude, (int, float))
        or not isinstance(latitude, (int, float))
        or not -180 <= longitude <= 180
        or not -90 <= latitude <= 90
    ):
        return None

    properties = message.get("properties")
    if not isinstance(properties, dict):
        properties = {}

    altitude = coordinates[2] if len(coordinates) > 2 else None
    if isinstance(altitude, bool) or not isinstance(altitude, (int, float)):
        altitude = None

    return {
        "type": "location",
        "topic": topic,
        "wireless_device_id": wireless_device_id,
        "longitude": longitude,
        "latitude": latitude,
        "altitude": altitude,
        "measurement_type": properties.get("measurementType"),
        "horizontal_accuracy": properties.get("horizontalAccuracy"),
        "vertical_accuracy": properties.get("verticalAccuracy"),
        "resolved_at": properties.get("timestamp"),
        "raw_message": message,
    }


# sid_demo message descriptor, one byte: bit7 status-header-present,
# bits6-5 opcode, bits4-3 command class, bits2-0 command id.
# See sid_demo_types.h (enum sid_demo_msg_desc_attributes) for the offsets.
_SID_DEMO_OPC_NOTIFY = 0x2
_SID_DEMO_OPC_RESP = 0x3
_SID_DEMO_APP_CLASS = 0x0
_SID_DEMO_CMD_CAP_DISCOVERY = 0x0


def _sid_demo_header(status_hdr: bool, opc: int, cmd_class: int, cmd_id: int) -> int:
    return (int(status_hdr) << 7) | ((opc & 0x3) << 5) | ((cmd_class & 0x3) << 3) | (cmd_id & 0x7)


# What the firmware waits for: a RESP to capability discovery, carrying a status
# header of SID_ERROR_NONE and no payload (app_rx.c checks all three).
SID_DEMO_CAPABILITY_RESPONSE = bytes(
    [_sid_demo_header(True, _SID_DEMO_OPC_RESP, _SID_DEMO_APP_CLASS, _SID_DEMO_CMD_CAP_DISCOVERY), 0x00]
)


# Diagnostic downlinks ride on sid_demo command class 1, which the demo protocol
# never uses, so no demo message definition has to change. The whole downlink is
# a single byte, which matters on a link whose payload budget can be 19 bytes.
# Handled by app_rx_diag_process() in app_rx.c.
_SID_DEMO_OPC_WRITE = 0x1
_SID_DEMO_DIAG_CLASS = 0x1

DIAG_CMD_CRASH_ASSERT = 0x0
DIAG_CMD_CRASH_HARDFAULT = 0x1
DIAG_CMD_REBOOT = 0x2

DIAG_COMMANDS = {
    "assert": DIAG_CMD_CRASH_ASSERT,
    "hardfault": DIAG_CMD_CRASH_HARDFAULT,
    "reboot": DIAG_CMD_REBOOT,
}


def sid_demo_diagnostic_downlink(command: str) -> bytes:
    """One byte that tells the device to crash or reboot on purpose.

    The device faults, the Memfault fault handler records the reason, and the
    reboot event is drained over Sidewalk on the next boot.
    """
    try:
        cmd_id = DIAG_COMMANDS[command]
    except KeyError:
        raise ValueError(
            f"Unknown diagnostic command {command!r}; expected one of {sorted(DIAG_COMMANDS)}"
        ) from None
    return bytes([_sid_demo_header(False, _SID_DEMO_OPC_WRITE, _SID_DEMO_DIAG_CLASS, cmd_id)])


def _is_capability_discovery_notify(demo_bytes: bytes) -> bool:
    """True for the capability discovery notification the device resends until answered."""
    if not demo_bytes:
        return False
    header = demo_bytes[0]
    return header == _sid_demo_header(
        False, _SID_DEMO_OPC_NOTIFY, _SID_DEMO_APP_CLASS, _SID_DEMO_CMD_CAP_DISCOVERY
    )


def _sid_demo_bytes_from_uplink(decoded_bytes: bytes, decoded_text: str) -> bytes:
    """Recover the binary sid_demo message from an uplink.

    Sidewalk delivers these payloads as ASCII hex rather than raw bytes (the
    same double encoding the Memfault chunk path has to undo), so prefer
    decoding the text when it looks like hex and fall back to the raw bytes.
    """
    if decoded_text and _is_hex_ascii(decoded_text):
        try:
            return bytes.fromhex(decoded_text)
        except ValueError:
            pass
    return decoded_bytes


def _get_signing_value(items: list[dict[str, Any]], alg: str) -> str:
    for item in items or []:
        if item.get("SigningAlg") == alg:
            return item.get("Value", "")
    return ""


def build_provisioning_json(
    wireless_device_json: dict[str, Any],
    device_profile_json: dict[str, Any],
) -> dict[str, Any]:
    sidewalk_device = wireless_device_json.get("Sidewalk", {})
    sidewalk_profile = device_profile_json.get("Sidewalk", {})
    device_type_id = ""
    cert_metadata = (
        sidewalk_profile.get("DakCertificateMetadata")
        or sidewalk_profile.get("DAKCertificateMetadata")
        or sidewalk_profile.get("DAKCertificate")
        or []
    )
    for cert_meta in cert_metadata:
        device_type_id = cert_meta.get("DeviceTypeId", "")
        if device_type_id:
            break

    return {
        "p256R1": _get_signing_value(sidewalk_device.get("DeviceCertificates", []), "P256r1"),
        "eD25519": _get_signing_value(sidewalk_device.get("DeviceCertificates", []), "Ed25519"),
        "metadata": {
            "deviceTypeId": device_type_id,
            "applicationDeviceArn": wireless_device_json.get("Arn", ""),
            "applicationDeviceId": wireless_device_json.get("Id", ""),
            "smsn": sidewalk_device.get("SidewalkManufacturingSn", ""),
            "devicePrivKeyP256R1": _get_signing_value(sidewalk_device.get("PrivateKeys", []), "P256r1"),
            "devicePrivKeyEd25519": _get_signing_value(sidewalk_device.get("PrivateKeys", []), "Ed25519"),
        },
        "applicationServerPublicKey": sidewalk_profile.get("ApplicationServerPublicKey", ""),
    }


@dataclass
class DownlinkRequest:
    text: str
    wireless_device_id: str
    device_name: str
    message_type: str = MESSAGE_TYPE_NOTIFY
    acked: bool = True
    seq: int | None = None
    # Set for payloads that are not text. The sid_demo protocol is binary and
    # its capability response starts with 0xE0, which is not valid UTF-8 on its
    # own, so encoding `text` would corrupt it.
    payload: bytes | None = None


class EventBroker:
    def __init__(self, backlog_size: int) -> None:
        self._history: deque[dict[str, Any]] = deque(maxlen=backlog_size)
        self._listeners: set[queue.Queue] = set()
        self._hooks: list[Callable[[dict[str, Any]], None]] = []
        self._lock = threading.Lock()
        self._next_event_id = 1

    def add_hook(self, hook: Callable[[dict[str, Any]], None]) -> None:
        """Register a server-side callback run once per published event.

        Unlike SSE listeners (per connected browser), hooks fire regardless of
        who is watching — used to persist uplinks to the database.
        """
        with self._lock:
            self._hooks.append(hook)

    def publish(self, event: dict[str, Any]) -> None:
        event = dict(event)
        event.setdefault("ts", utc_now_iso())

        with self._lock:
            event["_event_id"] = self._next_event_id
            self._next_event_id += 1
            self._history.append(event)
            hooks = list(self._hooks)
            listeners = list(self._listeners)

        for hook in hooks:
            try:
                hook(event)
            except Exception:
                LOGGER.warning("Event hook failed", exc_info=True)

        for listener in listeners:
            try:
                listener.put_nowait(event)
            except queue.Full:
                try:
                    listener.get_nowait()
                except queue.Empty:
                    pass
                try:
                    listener.put_nowait(event)
                except queue.Full:
                    LOGGER.warning("Dropping SSE event for a slow listener")

    def open_stream(
        self,
        after_event_id: int = 0,
        listener: queue.Queue | None = None,
        maxsize: int = 32,
    ) -> tuple[queue.Queue, list[dict[str, Any]]]:
        """Subscribe to this broker.

        Passing an existing ``listener`` subscribes one queue to several
        brokers, so a single consumer can block on one merged stream.
        """
        if listener is None:
            listener = queue.Queue(maxsize=maxsize)
        with self._lock:
            self._listeners.add(listener)
            latest_event_id = self._next_event_id - 1
            if after_event_id > latest_event_id:
                after_event_id = 0
            history = [
                event
                for event in self._history
                if int(event.get("_event_id", 0)) > after_event_id
            ]
        return listener, history

    def close_stream(self, listener: queue.Queue) -> None:
        with self._lock:
            self._listeners.discard(listener)


class SidewalkCloudService:
    def __init__(self, config: Any, broker: EventBroker) -> None:
        self._config = config
        self._broker = broker
        self._lock = threading.Lock()
        self._next_seq = 1
        self._listener_thread: threading.Thread | None = None
        self._listener_stop = threading.Event()
        self._mqtt_connection = None
        self._iot_client = None
        self._desired_topics: set[str] = set()
        self._subscribed_topics: set[str] = set()

    def start(self, topics: Iterable[str] | None = None) -> None:
        self._broker.publish(
            {
                "type": "service_status",
                "state": "starting",
                "detail": "Initializing Sidewalk cloud bridge",
            }
        )

        if self._has_placeholder_aws_credentials():
            self._broker.publish(
                {
                    "type": "service_status",
                    "state": "disabled",
                    "detail": "Set AWS credentials in the environment",
                }
            )
            return

        self._init_iotwireless_client()
        self._broker.publish(
            {
                "type": "service_status",
                "state": "ready",
                "detail": "AWS IoT Wireless control plane ready",
            }
        )

        self.sync_topics(topics or [])

    def sync_topics(self, topics: Iterable[str]) -> None:
        if self._has_placeholder_aws_credentials():
            return

        normalized = {topic for topic in topics if topic and not str(topic).startswith(PLACEHOLDER_PREFIX)}
        default_topic = self._config.AWS_IOT_UPLINK_TOPIC
        if default_topic and not str(default_topic).startswith(PLACEHOLDER_PREFIX):
            normalized.add(default_topic)
        location_topic = self._config.AWS_IOT_LOCATION_TOPIC
        if location_topic and not str(location_topic).startswith(PLACEHOLDER_PREFIX):
            normalized.add(location_topic)

        with self._lock:
            self._desired_topics = normalized

        if not normalized:
            self._broker.publish(
                {
                    "type": "service_status",
                    "state": "disabled",
                    "detail": "No uplink MQTT topic configured yet",
                }
            )
            return

        if self._has_placeholder_iot_endpoint():
            self._broker.publish(
                {
                    "type": "service_status",
                    "state": "disabled",
                    "detail": "Set AWS_IOT_ENDPOINT to enable MQTT uplink monitoring",
                }
            )
            return

        if self._listener_thread and self._listener_thread.is_alive():
            self._subscribe_topics(normalized)
            return

        self._start_listener_thread()

    def send_downlink(self, request: DownlinkRequest) -> dict[str, Any]:
        if boto3 is None:
            raise RuntimeError("boto3 is not installed")
        if not request.text and not request.payload:
            raise ValueError("Downlink payload cannot be empty")
        if self._has_placeholder_aws_credentials():
            raise RuntimeError("Set AWS credentials before sending downlinks")
        if self._iot_client is None:
            self._init_iotwireless_client()

        seq = request.seq if request.seq is not None else self._consume_seq()
        raw = request.payload if request.payload is not None else request.text.encode("utf-8")
        payload_b64 = base64.b64encode(raw).decode("ascii")

        response = self._iot_client.send_data_to_wireless_device(
            Id=request.wireless_device_id,
            TransmitMode=1 if request.acked else 0,
            PayloadData=payload_b64,
            WirelessMetadata={
                "Sidewalk": {
                    "Seq": seq,
                    "MessageType": request.message_type,
                    "AckModeRetryDurationSecs": (
                        self._config.SIDEWALK_DOWNLINK_ACK_RETRY_SECS if request.acked else 0
                    ),
                }
            },
        )

        event = {
            "type": "downlink_sent",
            "message_id": response.get("MessageId"),
            "seq": seq,
            "message_type": request.message_type,
            "acked": request.acked,
            "text": request.text,
            "payload_hex": raw.hex(),
            "wireless_device_id": request.wireless_device_id,
            "device_name": request.device_name,
        }
        self._broker.publish(event)
        return event

    def create_wireless_device(
        self,
        *,
        name: str,
        description: str,
        destination_name: str,
        location_destination_name: str,
        device_profile_id: str,
    ) -> dict[str, Any]:
        if self._iot_client is None:
            self._init_iotwireless_client()

        response = self._iot_client.create_wireless_device(
            Type="Sidewalk",
            Name=name,
            Description=description or "",
            DestinationName=destination_name,
            Positioning="Enabled",
            ClientRequestToken=str(uuid4()),
            Sidewalk={
                "DeviceProfileId": device_profile_id,
                "Positioning": {"DestinationName": location_destination_name},
            },
        )

        return {
            "id": response.get("Id"),
            "arn": response.get("Arn"),
            "name": response.get("Name", name),
        }

    def fetch_wireless_device_json(self, wireless_device_id: str) -> dict[str, Any]:
        if self._iot_client is None:
            self._init_iotwireless_client()
        return self._iot_client.get_wireless_device(
            IdentifierType="WirelessDeviceId",
            Identifier=wireless_device_id,
        )

    def fetch_device_profile_json(self, device_profile_id: str) -> dict[str, Any]:
        if self._iot_client is None:
            self._init_iotwireless_client()
        return self._iot_client.get_device_profile(Id=device_profile_id)

    def refresh_device_artifacts(
        self,
        *,
        wireless_device_id: str,
        device_profile_id: str,
    ) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        wireless_device_json = self.fetch_wireless_device_json(wireless_device_id)
        device_profile_json = self.fetch_device_profile_json(device_profile_id)
        provisioning_json = build_provisioning_json(wireless_device_json, device_profile_json)
        return wireless_device_json, device_profile_json, provisioning_json

    def _start_listener_thread(self) -> None:
        if self._listener_thread and self._listener_thread.is_alive():
            return

        self._listener_stop.clear()
        self._listener_thread = threading.Thread(
            target=self._mqtt_listener_main,
            name="sidewalk-mqtt-listener",
            daemon=True,
        )
        self._listener_thread.start()

    def _mqtt_listener_main(self) -> None:
        if any(mod is None for mod in (auth, io, mqtt, mqtt_connection_builder)):
            self._broker.publish(
                {
                    "type": "service_status",
                    "state": "error",
                    "detail": "awsiotsdk is not installed",
                }
            )
            return

        event_loop_group = io.EventLoopGroup(1)
        resolver = io.DefaultHostResolver(event_loop_group)
        bootstrap = io.ClientBootstrap(event_loop_group, resolver)
        credentials_provider = auth.AwsCredentialsProvider.new_static(
            self._config.AWS_ACCESS_KEY_ID,
            self._config.AWS_SECRET_ACCESS_KEY,
            self._config.AWS_SESSION_TOKEN or None,
        )

        self._mqtt_connection = mqtt_connection_builder.websockets_with_default_aws_signing(
            endpoint=self._config.AWS_IOT_ENDPOINT,
            client_bootstrap=bootstrap,
            region=self._config.AWS_REGION,
            credentials_provider=credentials_provider,
            client_id=self._config.MQTT_CLIENT_ID,
            clean_session=False,
            keep_alive_secs=30,
            on_connection_interrupted=self._on_connection_interrupted,
            on_connection_resumed=self._on_connection_resumed,
        )

        try:
            self._broker.publish(
                {
                    "type": "service_status",
                    "state": "connecting",
                    "detail": f"Connecting to {self._config.AWS_IOT_ENDPOINT}",
                }
            )
            self._mqtt_connection.connect().result()
            self._subscribe_topics(self._desired_topics)
            self._broker.publish(
                {
                    "type": "service_status",
                    "state": "connected",
                    "detail": "MQTT uplink listener connected",
                }
            )
        except Exception as exc:  # pragma: no cover - network dependent
            LOGGER.exception("Failed to start MQTT listener")
            self._broker.publish(
                {
                    "type": "service_status",
                    "state": "error",
                    "detail": f"MQTT listener failed: {exc}",
                }
            )
            return

        while not self._listener_stop.wait(1.0):
            pass

        try:
            self._mqtt_connection.disconnect().result(timeout=5)
        except Exception:  # pragma: no cover - best effort shutdown
            LOGGER.warning("MQTT disconnect failed during shutdown", exc_info=True)

    def _subscribe_topics(self, topics: Iterable[str]) -> None:
        if self._mqtt_connection is None or mqtt is None:
            return

        topics_to_add = sorted(set(topics) - self._subscribed_topics)
        for topic in topics_to_add:
            subscribe_future, _ = self._mqtt_connection.subscribe(
                topic=topic,
                qos=mqtt.QoS.AT_LEAST_ONCE,
                callback=self._on_mqtt_message,
            )
            subscribe_future.result()
            self._subscribed_topics.add(topic)
            self._broker.publish(
                {
                    "type": "service_status",
                    "state": "connected",
                    "detail": f"Subscribed to {topic}",
                    "topic": topic,
                }
            )

    def _on_connection_interrupted(self, connection, error, **kwargs) -> None:
        del connection, kwargs
        self._broker.publish(
            {
                "type": "service_status",
                "state": "interrupted",
                "detail": f"MQTT interrupted: {error}",
            }
        )

    def _on_connection_resumed(self, connection, return_code, session_present, **kwargs) -> None:
        del connection, kwargs
        self._broker.publish(
            {
                "type": "service_status",
                "state": "connected",
                "detail": f"MQTT resumed (rc={return_code}, session_present={session_present})",
            }
        )
        self._subscribe_topics(self._desired_topics)

    def _on_mqtt_message(self, topic: str, payload: bytes, **kwargs) -> None:
        del kwargs
        raw_text = payload.decode("utf-8", errors="replace")
        try:
            message = json.loads(raw_text)
        except json.JSONDecodeError:
            self._broker.publish({"type": "uplink_raw", "topic": topic, "raw": raw_text})
            return

        location = _location_event(message, topic)
        if location is not None:
            self._broker.publish(location)
            return

        payload_data = message.get("PayloadData")
        decoded_bytes = b""
        decoded_text = ""
        payload_json = None
        if payload_data:
            try:
                raw_bytes = base64.b64decode(payload_data)
            except Exception:
                LOGGER.warning("Failed to decode uplink payload", exc_info=True)
                raw_bytes = b""

            chunk = _memfault_chunk_from_payload(raw_bytes)
            if chunk is not None:
                sequence, chunk_bytes = chunk
                sidewalk_meta = message.get("WirelessMetadata", {}).get("Sidewalk", {})
                self._broker.publish(
                    {
                        "type": "memfault_chunk",
                        "topic": topic,
                        "wireless_device_id": message.get("WirelessDeviceId"),
                        "link_name": _link_name(sidewalk_meta.get("LinkType")),
                        "memfault_sequence": sequence,
                        "memfault_chunk_hex": chunk_bytes.hex(),
                        "memfault_chunk_len": len(chunk_bytes),
                        "payload_hex": chunk_bytes.hex(),
                        "detail": f"Memfault chunk seq {sequence} ({len(chunk_bytes)} bytes)",
                    }
                )
                return

            try:
                decoded_bytes, decoded_text, payload_json = _decode_nested_payload(raw_bytes)
            except Exception:
                LOGGER.warning("Failed to decode uplink payload", exc_info=True)

        sidewalk_meta = message.get("WirelessMetadata", {}).get("Sidewalk", {})
        event = {
            "type": "uplink",
            "topic": topic,
            "wireless_device_id": message.get("WirelessDeviceId"),
            "payload_data": payload_data,
            "payload_text": decoded_text,
            "payload_hex": decoded_bytes.hex() if decoded_bytes else "",
            "payload_json": payload_json,
            "link_type": sidewalk_meta.get("LinkType"),
            "link_name": _link_name(sidewalk_meta.get("LinkType")),
            "sequence_number": sidewalk_meta.get("Seq"),
            "raw_message": message,
        }

        if decoded_text == "button":
            event["semantic"] = "button_press"
        elif isinstance(payload_json, dict) and payload_json.get("event"):
            event["semantic"] = payload_json.get("event")

        self._broker.publish(event)

        if getattr(self._config, "SIDEWALK_AUTO_CAPABILITY_RESPONSE", False):
            self._answer_capability_discovery(
                message.get("WirelessDeviceId"),
                _sid_demo_bytes_from_uplink(decoded_bytes, decoded_text),
            )

    def _answer_capability_discovery(self, wireless_device_id: Any, demo_bytes: bytes) -> None:
        """Reply to the device's capability discovery so it starts sending telemetry.

        Sent unacked: if it is lost the device just resends capability and we
        answer the next one, which is cheaper than an acked retry storm.
        """
        if not isinstance(wireless_device_id, str) or not wireless_device_id:
            return
        if not _is_capability_discovery_notify(demo_bytes):
            return

        try:
            self.send_downlink(
                DownlinkRequest(
                    text="",
                    payload=SID_DEMO_CAPABILITY_RESPONSE,
                    wireless_device_id=wireless_device_id,
                    device_name="",
                    acked=False,
                )
            )
        except Exception:
            LOGGER.warning("Failed to answer capability discovery", exc_info=True)
            return

        LOGGER.info("Answered capability discovery for %s", wireless_device_id)

    def _consume_seq(self) -> int:
        with self._lock:
            seq = self._next_seq
            self._next_seq = (self._next_seq + 1) % 16384
            if self._next_seq == 0:
                self._next_seq = 1
        return seq

    def _init_iotwireless_client(self) -> None:
        if boto3 is None:
            raise RuntimeError("boto3 is not installed")

        session = boto3.session.Session(
            aws_access_key_id=self._config.AWS_ACCESS_KEY_ID,
            aws_secret_access_key=self._config.AWS_SECRET_ACCESS_KEY,
            aws_session_token=self._config.AWS_SESSION_TOKEN or None,
            region_name=self._config.AWS_REGION,
        )
        self._iot_client = session.client("iotwireless")

    def _has_placeholder_aws_credentials(self) -> bool:
        values = (self._config.AWS_ACCESS_KEY_ID, self._config.AWS_SECRET_ACCESS_KEY)
        return any(str(value).startswith(PLACEHOLDER_PREFIX) for value in values)

    def _has_placeholder_iot_endpoint(self) -> bool:
        return str(self._config.AWS_IOT_ENDPOINT).startswith(PLACEHOLDER_PREFIX)
