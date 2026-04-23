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
                    ble_name_prefix TEXT NOT NULL DEFAULT 'XIAO-WebShell',
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    wireless_device_json TEXT,
                    device_profile_json TEXT,
                    provisioning_json TEXT
                );
                """
            )

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
                    INSERT INTO users (email, password_hash, role, display_name, active, notes, created_at)
                    VALUES (?, ?, 'admin', ?, 1, '', ?)
                    """,
                    (email, password_hash, "Administrator", now),
                )
                return
            if not check_password_hash(row["password_hash"], password):
                conn.execute(
                    "UPDATE users SET password_hash = ?, active = 1 WHERE id = ?",
                    (password_hash, row["id"]),
                )

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
                        uplink_topic, device_profile_id, created_at, updated_at
                    ) VALUES (NULL, ?, '', ?, ?, ?, ?, ?, ?)
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

    def create_customer(self, email: str, password: str, display_name: str, notes: str) -> dict[str, Any]:
        now = utc_now_iso()
        password_hash = generate_password_hash(password)
        with self.connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO users (email, password_hash, role, display_name, active, notes, created_at)
                VALUES (?, ?, 'customer', ?, 1, ?, ?)
                """,
                (email, password_hash, display_name or email, notes or "", now),
            )
            row = conn.execute("SELECT * FROM users WHERE id = ?", (cursor.lastrowid,)).fetchone()
            return dict(row)

    def list_customers(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT u.*,
                       COUNT(d.id) AS device_count
                FROM users u
                LEFT JOIN devices d ON d.customer_user_id = u.id
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
                    SELECT d.*, u.email AS customer_email, u.display_name AS customer_name
                    FROM devices d
                    LEFT JOIN users u ON u.id = d.customer_user_id
                    WHERE d.active = 1
                    ORDER BY d.created_at DESC
                    """
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT d.*, u.email AS customer_email, u.display_name AS customer_name
                    FROM devices d
                    LEFT JOIN users u ON u.id = d.customer_user_id
                    WHERE d.active = 1 AND d.customer_user_id = ?
                    ORDER BY d.created_at DESC
                    """,
                    (user["id"],),
                ).fetchall()
            return [self._decode_device_row(row) for row in rows]

    def list_all_devices(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT d.*, u.email AS customer_email, u.display_name AS customer_name
                FROM devices d
                LEFT JOIN users u ON u.id = d.customer_user_id
                ORDER BY d.created_at DESC
                """
            ).fetchall()
            return [self._decode_device_row(row) for row in rows]

    def get_device(self, device_id: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                """
                SELECT d.*, u.email AS customer_email, u.display_name AS customer_name
                FROM devices d
                LEFT JOIN users u ON u.id = d.customer_user_id
                WHERE d.id = ?
                """,
                (device_id,),
            ).fetchone()
            return self._decode_device_row(row) if row else None

    def get_device_for_user(self, user: dict[str, Any], device_id: int) -> dict[str, Any] | None:
        device = self.get_device(device_id)
        if device is None:
            return None
        if user["role"] == "admin" or device["customer_user_id"] == user["id"]:
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
                    ble_name_prefix or "XIAO-WebShell",
                    now,
                    now,
                    json.dumps(wireless_device_json) if wireless_device_json else None,
                    json.dumps(device_profile_json) if device_profile_json else None,
                    json.dumps(provisioning_json) if provisioning_json else None,
                ),
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
        return item
