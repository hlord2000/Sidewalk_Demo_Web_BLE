from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from werkzeug.security import check_password_hash, generate_password_hash


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class AuthResult:
    ok: bool
    user: dict[str, Any] | None = None
    error: str | None = None


class DemoStore:
    def __init__(self, db_path: str) -> None:
        self.db_path = Path(db_path)
        if not self.db_path.is_absolute():
            self.db_path = Path(__file__).resolve().parent / self.db_path

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def init_db(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('admin', 'customer')),
                    display_name TEXT,
                    active INTEGER NOT NULL DEFAULT 1,
                    can_provision INTEGER NOT NULL DEFAULT 0,
                    notes TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    last_login_at TEXT
                );

                CREATE TABLE IF NOT EXISTS devices (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    wireless_device_id TEXT NOT NULL UNIQUE,
                    destination_name TEXT NOT NULL DEFAULT '',
                    uplink_topic TEXT NOT NULL DEFAULT '',
                    device_profile_id TEXT NOT NULL DEFAULT '',
                    ble_name_prefix TEXT NOT NULL DEFAULT 'WebShell',
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    wireless_device_json TEXT,
                    device_profile_json TEXT,
                    provisioning_json TEXT
                );

                CREATE TABLE IF NOT EXISTS device_customer_access (
                    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                    customer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (device_id, customer_user_id)
                );

                CREATE TABLE IF NOT EXISTS sensor_readings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    wireless_device_id TEXT NOT NULL,
                    ts TEXT NOT NULL,
                    link_name TEXT,
                    payload_json TEXT,
                    payload_hex TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_sensor_readings_wid_ts
                    ON sensor_readings (wireless_device_id, ts);
                """
            )
            conn.execute(
                """
                INSERT OR IGNORE INTO device_customer_access (device_id, customer_user_id, created_at)
                SELECT id, customer_user_id, created_at
                FROM devices
                WHERE customer_user_id IS NOT NULL
                """
            )
            conn.execute(
                "UPDATE devices SET ble_name_prefix = 'WebShell' WHERE ble_name_prefix = 'XIAO-WebShell'"
            )
            self._ensure_column(conn, "users", "can_provision", "INTEGER NOT NULL DEFAULT 0")
            conn.execute("UPDATE users SET can_provision = 1 WHERE role = 'admin'")

    def _ensure_column(self, conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
        columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def seed_admin(self, email: str, password: str) -> None:
        if not email or not password or email.startswith("REPLACE_") or password.startswith("REPLACE_"):
            return
        now = utc_now_iso()
        with self.connect() as conn:
            row = conn.execute("SELECT id, password_hash FROM users WHERE role = 'admin' AND email = ?", (email,)).fetchone()
            password_hash = generate_password_hash(password)
            if row is None:
                conn.execute(
                    """
                    INSERT INTO users (email, password_hash, role, display_name, active, can_provision, notes, created_at)
                    VALUES (?, ?, 'admin', ?, 1, 1, '', ?)
                    """,
                    (email, password_hash, "Administrator", now),
                )
                return
            if not check_password_hash(row["password_hash"], password):
                conn.execute(
                    "UPDATE users SET password_hash = ?, active = 1, can_provision = 1 WHERE id = ?",
                    (password_hash, row["id"]),
                )
            else:
                conn.execute("UPDATE users SET active = 1, can_provision = 1 WHERE id = ?", (row["id"],))

    def seed_default_device(
        self,
        wireless_device_id: str,
        uplink_topic: str,
        destination_name: str,
        device_profile_id: str,
    ) -> None:
        if not wireless_device_id or wireless_device_id.startswith("REPLACE_"):
            return

        now = utc_now_iso()
        with self.connect() as conn:
            row = conn.execute(
                "SELECT id FROM devices WHERE wireless_device_id = ?",
                (wireless_device_id,),
            ).fetchone()
            if row:
                conn.execute(
                    """
                    UPDATE devices
                    SET uplink_topic = ?, destination_name = ?, device_profile_id = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (uplink_topic or "", destination_name or "", device_profile_id or "", now, row["id"]),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO devices (
                        customer_user_id, name, description, wireless_device_id, destination_name,
                        uplink_topic, device_profile_id, ble_name_prefix, created_at, updated_at
                    ) VALUES (NULL, ?, '', ?, ?, ?, ?, 'WebShell', ?, ?)
                    """,
                    (
                        "Primary Demo Device",
                        wireless_device_id,
                        destination_name or "",
                        uplink_topic or "",
                        device_profile_id or "",
                        now,
                        now,
                    ),
                )

    def authenticate_user(self, email: str, password: str) -> AuthResult:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE email = ? AND active = 1",
                (email,),
            ).fetchone()
            if row is None or not check_password_hash(row["password_hash"], password):
                return AuthResult(ok=False, error="Invalid credentials")

            conn.execute(
                "UPDATE users SET last_login_at = ? WHERE id = ?",
                (utc_now_iso(), row["id"]),
            )
            return AuthResult(ok=True, user=dict(row))

    def get_user(self, user_id: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            return dict(row) if row else None

    def create_customer(
        self,
        email: str,
        password: str,
        display_name: str,
        notes: str,
        can_provision: bool = False,
    ) -> dict[str, Any]:
        now = utc_now_iso()
        password_hash = generate_password_hash(password)
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO users (email, password_hash, role, display_name, active, can_provision, notes, created_at)
                VALUES (?, ?, 'customer', ?, 1, ?, ?, ?)
                """,
                (email, password_hash, display_name or email, int(can_provision), notes or "", now),
            )
            row = conn.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
            return dict(row)

    def update_customer_permissions(self, customer_user_id: int, *, can_provision: bool) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE users
                SET can_provision = ?
                WHERE id = ? AND role = 'customer'
                """,
                (int(can_provision), customer_user_id),
            )

    def list_customers(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT u.*,
                       COUNT(dca.device_id) AS device_count
                FROM users u
                LEFT JOIN device_customer_access dca ON dca.customer_user_id = u.id
                WHERE u.role = 'customer'
                GROUP BY u.id
                ORDER BY u.created_at DESC
                """
            ).fetchall()
            return [dict(row) for row in rows]

    def list_devices_for_user(self, user: dict[str, Any]) -> list[dict[str, Any]]:
        with self.connect() as conn:
            if user["role"] == "admin":
                rows = conn.execute(
                    """
                    SELECT d.*,
                           GROUP_CONCAT(u.email, ', ') AS customer_email,
                           GROUP_CONCAT(COALESCE(u.display_name, u.email), ', ') AS customer_name,
                           GROUP_CONCAT(u.id) AS customer_ids
                    FROM devices d
                    LEFT JOIN device_customer_access dca ON dca.device_id = d.id
                    LEFT JOIN users u ON u.id = dca.customer_user_id
                    WHERE d.active = 1
                    GROUP BY d.id
                    ORDER BY d.created_at DESC
                    """
                ).fetchall()
            else:
                # Customers must only ever see their own association with a
                # device, never the other customers it is shared with. Join
                # solely on the requesting user's access row so the customer
                # name/email/id fields can never expose another customer.
                rows = conn.execute(
                    """
                    SELECT d.*,
                           u.email AS customer_email,
                           COALESCE(u.display_name, u.email) AS customer_name,
                           CAST(u.id AS TEXT) AS customer_ids
                    FROM devices d
                    JOIN device_customer_access dca
                      ON dca.device_id = d.id AND dca.customer_user_id = ?
                    JOIN users u ON u.id = dca.customer_user_id
                    WHERE d.active = 1
                    ORDER BY d.created_at DESC
                    """,
                    (user["id"],),
                ).fetchall()
            return [self._decode_device_row(row) for row in rows]

    def record_sensor_reading(
        self,
        *,
        wireless_device_id: str | None,
        ts: str,
        link_name: str | None,
        payload_json: Any | None,
        payload_hex: str | None,
    ) -> None:
        """Persist one uplink so historical sensor data survives restarts."""
        if not wireless_device_id:
            return
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO sensor_readings
                    (wireless_device_id, ts, link_name, payload_json, payload_hex, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    wireless_device_id,
                    ts,
                    link_name,
                    json.dumps(payload_json) if payload_json is not None else None,
                    payload_hex or None,
                    utc_now_iso(),
                ),
            )

    def sensor_readings(
        self,
        wireless_device_id: str,
        since_iso: str,
        limit: int = 5000,
    ) -> list[dict[str, Any]]:
        """Most recent readings at or after ``since_iso``, oldest-first."""
        if not wireless_device_id:
            return []
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT ts, link_name, payload_json, payload_hex
                FROM sensor_readings
                WHERE wireless_device_id = ? AND ts >= ?
                ORDER BY ts DESC, created_at DESC, rowid DESC
                LIMIT ?
                """,
                (wireless_device_id, since_iso, limit),
            ).fetchall()
        readings = []
        for row in reversed(rows):
            item = dict(row)
            raw = item.get("payload_json")
            item["payload_json"] = json.loads(raw) if raw else None
            readings.append(item)
        return readings

    def list_all_devices(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT d.*,
                       GROUP_CONCAT(u.email, ', ') AS customer_email,
                       GROUP_CONCAT(COALESCE(u.display_name, u.email), ', ') AS customer_name,
                       GROUP_CONCAT(u.id) AS customer_ids
                FROM devices d
                LEFT JOIN device_customer_access dca ON dca.device_id = d.id
                LEFT JOIN users u ON u.id = dca.customer_user_id
                GROUP BY d.id
                ORDER BY d.created_at DESC
                """
            ).fetchall()
            return [self._decode_device_row(row) for row in rows]

    def get_device(self, device_id: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT d.*,
                       GROUP_CONCAT(u.email, ', ') AS customer_email,
                       GROUP_CONCAT(COALESCE(u.display_name, u.email), ', ') AS customer_name,
                       GROUP_CONCAT(u.id) AS customer_ids
                FROM devices d
                LEFT JOIN device_customer_access dca ON dca.device_id = d.id
                LEFT JOIN users u ON u.id = dca.customer_user_id
                WHERE d.id = ?
                GROUP BY d.id
                """,
                (device_id,),
            ).fetchone()
            return self._decode_device_row(row) if row else None

    def get_device_for_user(self, user: dict[str, Any], device_id: int) -> dict[str, Any] | None:
        device = self.get_device(device_id)
        if device is None:
            return None
        if user["role"] == "admin" or user["id"] in device.get("customer_ids", []):
            return device
        return None

    def create_device_record(
        self,
        *,
        customer_user_id: int | None,
        name: str,
        description: str,
        wireless_device_id: str,
        destination_name: str,
        uplink_topic: str,
        device_profile_id: str,
        ble_name_prefix: str,
        wireless_device_json: dict[str, Any] | None = None,
        device_profile_json: dict[str, Any] | None = None,
        provisioning_json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = utc_now_iso()
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO devices (
                    customer_user_id, name, description, wireless_device_id, destination_name,
                    uplink_topic, device_profile_id, ble_name_prefix, active, created_at, updated_at,
                    wireless_device_json, device_profile_json, provisioning_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
                """,
                (
                    customer_user_id,
                    name,
                    description or "",
                    wireless_device_id,
                    destination_name or "",
                    uplink_topic or "",
                    device_profile_id or "",
                    ble_name_prefix or "WebShell",
                    now,
                    now,
                    json.dumps(wireless_device_json) if wireless_device_json else None,
                    json.dumps(device_profile_json) if device_profile_json else None,
                    json.dumps(provisioning_json) if provisioning_json else None,
                ),
            )
            if customer_user_id is not None:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO device_customer_access (device_id, customer_user_id, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (cursor.lastrowid, customer_user_id, now),
                )
            row = conn.execute("SELECT * FROM devices WHERE id = ?", (cursor.lastrowid,)).fetchone()
            return self._decode_device_row(row)

    def update_device_artifacts(
        self,
        device_id: int,
        *,
        wireless_device_json: dict[str, Any] | None,
        device_profile_json: dict[str, Any] | None,
        provisioning_json: dict[str, Any] | None,
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE devices
                SET wireless_device_json = ?,
                    device_profile_json = ?,
                    provisioning_json = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    json.dumps(wireless_device_json) if wireless_device_json else None,
                    json.dumps(device_profile_json) if device_profile_json else None,
                    json.dumps(provisioning_json) if provisioning_json else None,
                    utc_now_iso(),
                    device_id,
                ),
            )

    def update_device_customers(self, device_id: int, customer_user_ids: list[int]) -> None:
        with self.connect() as conn:
            now = utc_now_iso()
            unique_customer_ids = list(dict.fromkeys(customer_user_ids))
            conn.execute("DELETE FROM device_customer_access WHERE device_id = ?", (device_id,))
            conn.executemany(
                """
                INSERT INTO device_customer_access (device_id, customer_user_id, created_at)
                VALUES (?, ?, ?)
                """,
                [(device_id, customer_id, now) for customer_id in unique_customer_ids],
            )
            conn.execute(
                """
                UPDATE devices
                SET customer_user_id = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (unique_customer_ids[0] if unique_customer_ids else None, now, device_id),
            )

    def unique_uplink_topics(self) -> list[str]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT DISTINCT uplink_topic FROM devices WHERE active = 1 AND uplink_topic != ''"
            ).fetchall()
            return [row["uplink_topic"] for row in rows]

    def _decode_device_row(self, row: sqlite3.Row | None) -> dict[str, Any]:
        if row is None:
            return {}
        item = dict(row)
        for key in ("wireless_device_json", "device_profile_json", "provisioning_json"):
            value = item.get(key)
            item[key] = json.loads(value) if value else None
        customer_ids = item.get("customer_ids")
        item["customer_ids"] = [int(value) for value in customer_ids.split(",")] if customer_ids else []
        return item
