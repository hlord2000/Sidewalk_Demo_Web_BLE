from __future__ import annotations

import base64
import json
import logging
import queue
import threading
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable
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


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _is_printable_ascii(data: bytes) -> bool:
    return all(32 <= b <= 126 or b in (9, 10, 13) for b in data)


def _is_hex_ascii(text: str) -> bool:
    if not text or (len(text) % 2) != 0:
        return False
    return all(ch in "0123456789abcdefABCDEF" for ch in text)


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
    for cert_meta in sidewalk_profile.get("DAKCertificateMetadata", []) or []:
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


class EventBroker:
    def __init__(self, backlog_size: int) -> None:
        self._history: deque[dict[str, Any]] = deque(maxlen=backlog_size)
        self._listeners: set[queue.Queue] = set()
        self._lock = threading.Lock()

    def publish(self, event: dict[str, Any]) -> None:
        event = dict(event)
        event.setdefault("ts", utc_now_iso())

        with self._lock:
            self._history.append(event)
            listeners = list(self._listeners)

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

    def open_stream(self) -> tuple[queue.Queue, list[dict[str, Any]]]:
        listener: queue.Queue = queue.Queue(maxsize=32)
        with self._lock:
            self._listeners.add(listener)
            history = list(self._history)
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
        if not request.text:
            raise ValueError("Downlink payload cannot be empty")
        if self._has_placeholder_aws_credentials():
            raise RuntimeError("Set AWS credentials before sending downlinks")
        if self._iot_client is None:
            self._init_iotwireless_client()

        seq = request.seq if request.seq is not None else self._consume_seq()
        payload_b64 = base64.b64encode(request.text.encode("utf-8")).decode("ascii")

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
        device_profile_id: str,
    ) -> dict[str, Any]:
        if self._iot_client is None:
            self._init_iotwireless_client()

        response = self._iot_client.create_wireless_device(
            Type="Sidewalk",
            Name=name,
            Description=description or "",
            DestinationName=destination_name,
            ClientRequestToken=str(uuid4()),
            Sidewalk={"DeviceProfileId": device_profile_id},
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

        payload_data = message.get("PayloadData")
        decoded_bytes = b""
        decoded_text = ""
        payload_json = None
        if payload_data:
            try:
                decoded_bytes = base64.b64decode(payload_data)
                decoded_bytes, decoded_text, payload_json = _decode_nested_payload(decoded_bytes)
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
