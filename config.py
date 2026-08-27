"""
Runtime configuration for the Sidewalk web demo.

This module is intentionally environment-variable driven so the app can be
deployed safely to GitHub + Railway without committing secrets.
"""

from __future__ import annotations

import os


PLACEHOLDER_PREFIX = "REPLACE_"


def _env(name: str, default: str) -> str:
    return os.getenv(name, default)


def _env_alias(primary: str, secondary: str, default: str) -> str:
    return os.getenv(primary) or os.getenv(secondary) or default


def _int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value in (None, ""):
        return default
    return int(value)


def _auto_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value in (None, ""):
        return default
    return int(value, 0)


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value in (None, ""):
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class DemoConfig:
    FLASK_SECRET_KEY = _env("FLASK_SECRET_KEY", "REPLACE_FLASK_SECRET_KEY")
    SESSION_COOKIE_SECURE = _bool_env("SESSION_COOKIE_SECURE", False)

    ADMIN_EMAIL = _env_alias("ADMIN_EMAIL", "LOGIN_EMAIL", "REPLACE_ADMIN_EMAIL")
    ADMIN_PASSWORD = _env_alias("ADMIN_PASSWORD", "LOGIN_PASSWORD", "REPLACE_ADMIN_PASSWORD")
    DATABASE_PATH = _env("DATABASE_PATH", "sidewalk_demo.db")

    AWS_REGION = _env("AWS_REGION", "us-east-1")
    AWS_ACCESS_KEY_ID = _env("AWS_ACCESS_KEY_ID", "REPLACE_AWS_ACCESS_KEY_ID")
    AWS_SECRET_ACCESS_KEY = _env("AWS_SECRET_ACCESS_KEY", "REPLACE_AWS_SECRET_ACCESS_KEY")
    AWS_SESSION_TOKEN = _env("AWS_SESSION_TOKEN", "")
    AWS_IOT_ENDPOINT = _env("AWS_IOT_ENDPOINT", "REPLACE_AWS_IOT_ENDPOINT")
    AWS_IOT_UPLINK_TOPIC = _env("AWS_IOT_UPLINK_TOPIC", "REPLACE_AWS_IOT_UPLINK_TOPIC")
    SIDEWALK_DESTINATION_NAME = _env("SIDEWALK_DESTINATION_NAME", "")
    AWS_IOT_LOCATION_TOPIC = _env("AWS_IOT_LOCATION_TOPIC", AWS_IOT_UPLINK_TOPIC)
    SIDEWALK_LOCATION_DESTINATION_NAME = _env(
        "SIDEWALK_LOCATION_DESTINATION_NAME",
        SIDEWALK_DESTINATION_NAME,
    )
    SIDEWALK_DEVICE_PROFILE_ID = _env("SIDEWALK_DEVICE_PROFILE_ID", "")
    SIDEWALK_WIRELESS_DEVICE_ID = _env(
        "SIDEWALK_WIRELESS_DEVICE_ID",
        "REPLACE_SIDEWALK_WIRELESS_DEVICE_ID",
    )
    SIDEWALK_DOWNLINK_ACK_RETRY_SECS = _int_env("SIDEWALK_DOWNLINK_ACK_RETRY_SECS", 10)
    # The sensor monitoring firmware will not start sending telemetry until the
    # cloud answers its capability discovery notification: app_rx.c raises
    # APP_EVENT_CAPABILITY_SUCCESS only on that response, and app_tx.c's state
    # machine needs it to leave STATE_APP_NOTIFY_CAPABILITY. Without a
    # responder the device resends capability forever and the sensor monitor
    # stays empty, so answer it here. Set false to watch the raw retry
    # behaviour instead.
    SIDEWALK_AUTO_CAPABILITY_RESPONSE = _bool_env("SIDEWALK_AUTO_CAPABILITY_RESPONSE", True)
    SIDEWALK_MFG_STORAGE_ADDRESS = _auto_int_env("SIDEWALK_MFG_STORAGE_ADDRESS", 0x162000)
    # Raw bytes per "prov set" fragment, before base64 expansion, for the BLE
    # NUS provisioning command script. The largest single credential value is
    # 64 bytes (a P256r1 public key or a signature), so this conservative
    # default lets every value ship unfragmented; lower it if the real NUS
    # MTU and shell line buffer budget turn out to be tighter than that.
    SIDEWALK_PROVISIONING_MAX_FRAGMENT_BYTES = _int_env("SIDEWALK_PROVISIONING_MAX_FRAGMENT_BYTES", 64)

    MQTT_CLIENT_ID = _env("MQTT_CLIENT_ID", "sidewalk-web-demo")
    EVENT_BACKLOG_SIZE = _int_env("EVENT_BACKLOG_SIZE", 64)

    NUS_SERVICE_UUID = _env("NUS_SERVICE_UUID", "6e400001-b5a3-f393-e0a9-e50e24dcca9e")
    NUS_RX_UUID = _env("NUS_RX_UUID", "6e400002-b5a3-f393-e0a9-e50e24dcca9e")
    NUS_TX_UUID = _env("NUS_TX_UUID", "6e400003-b5a3-f393-e0a9-e50e24dcca9e")

    SIDEWALK_BLE_SERVICE_UUID = _env(
        "SIDEWALK_BLE_SERVICE_UUID",
        "0000fe03-0000-1000-8000-00805f9b34fb",
    )
    SIDEWALK_BLE_WRITE_UUID = _env(
        "SIDEWALK_BLE_WRITE_UUID",
        "74f996c9-7d6c-4d58-9232-0427ab61c53c",
    )
    SIDEWALK_BLE_NOTIFY_UUID = _env(
        "SIDEWALK_BLE_NOTIFY_UUID",
        "b32e83c0-fece-47c1-9015-53b7e7f0d2fe",
    )

    # Memfault gateway. The device has no IP stack, so this backend forwards
    # Memfault SDK "chunks" arriving as Sidewalk uplinks to Memfault's chunks
    # API, and optionally reads device health back from Memfault's org API.
    # Every value below defaults to "off", so the app boots with none of them set.
    MEMFAULT_ENABLED = _bool_env("MEMFAULT_ENABLED", False)
    MEMFAULT_PROJECT_KEY = _env("MEMFAULT_PROJECT_KEY", "")
    MEMFAULT_ORG_SLUG = _env("MEMFAULT_ORG_SLUG", "")
    MEMFAULT_PROJECT_SLUG = _env("MEMFAULT_PROJECT_SLUG", "")
    MEMFAULT_ORG_AUTH_TOKEN = _env("MEMFAULT_ORG_AUTH_TOKEN", "")
    MEMFAULT_CHUNKS_BASE_URL = _env("MEMFAULT_CHUNKS_BASE_URL", "https://chunks.memfault.com")
    MEMFAULT_API_BASE_URL = _env("MEMFAULT_API_BASE_URL", "https://api.memfault.com")
    # "smsn" (default) uses the device's Sidewalk manufacturing serial when known,
    # falling back to its wireless_device_id. "wireless_device_id" always uses that.
    MEMFAULT_DEVICE_SERIAL_SOURCE = _env("MEMFAULT_DEVICE_SERIAL_SOURCE", "smsn")
    MEMFAULT_HTTP_TIMEOUT_SECS = _int_env("MEMFAULT_HTTP_TIMEOUT_SECS", 10)
    MEMFAULT_CHUNK_MAX_ATTEMPTS = _int_env("MEMFAULT_CHUNK_MAX_ATTEMPTS", 8)
    MEMFAULT_CHUNK_MAX_BACKOFF_SECS = _int_env("MEMFAULT_CHUNK_MAX_BACKOFF_SECS", 300)
    MEMFAULT_WORKER_POLL_SECS = _int_env("MEMFAULT_WORKER_POLL_SECS", 5)
