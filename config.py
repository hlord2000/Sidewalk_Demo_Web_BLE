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
    SIDEWALK_DEVICE_PROFILE_ID = _env("SIDEWALK_DEVICE_PROFILE_ID", "")
    SIDEWALK_WIRELESS_DEVICE_ID = _env(
        "SIDEWALK_WIRELESS_DEVICE_ID",
        "REPLACE_SIDEWALK_WIRELESS_DEVICE_ID",
    )
    SIDEWALK_DOWNLINK_ACK_RETRY_SECS = _int_env("SIDEWALK_DOWNLINK_ACK_RETRY_SECS", 10)

    MQTT_CLIENT_ID = _env("MQTT_CLIENT_ID", "sidewalk-web-demo")
    EVENT_BACKLOG_SIZE = _int_env("EVENT_BACKLOG_SIZE", 64)

    NUS_SERVICE_UUID = _env("NUS_SERVICE_UUID", "6e400001-b5a3-f393-e0a9-e50e24dcca9e")
    NUS_RX_UUID = _env("NUS_RX_UUID", "6e400002-b5a3-f393-e0a9-e50e24dcca9e")
    NUS_TX_UUID = _env("NUS_TX_UUID", "6e400003-b5a3-f393-e0a9-e50e24dcca9e")
