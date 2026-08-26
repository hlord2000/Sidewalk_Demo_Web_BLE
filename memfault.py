"""Memfault gateway for devices with no IP stack of their own.

The nRF54L15 firmware runs the Memfault SDK's packetizer and emits opaque
"chunks" as Sidewalk uplinks (see iot.py's _memfault_chunk_from_payload).
MemfaultService is the other half: it drains a persisted queue of those
chunks and re-POSTs each one verbatim to Memfault's chunks API, and offers a
small read client for showing device health on the dashboard. The device
never holds a Memfault project key.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

import requests

import provisioning

LOGGER = logging.getLogger(__name__)


def _name_of(value: Any) -> str | None:
    """Flatten a Memfault field that may be a plain string or a nested object.

    hardware_version, cohort and the software version all come back as
    {"name": ...} or {"version": ...} rather than a bare string, so rendering
    them directly produced "[object Object]" in the dashboard.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    if isinstance(value, dict):
        for key in ("name", "version", "slug"):
            found = value.get(key)
            if isinstance(found, str) and found:
                return found
    return None

CHUNKS_UPLOAD_SUCCESS_STATUS = 202


class MemfaultService:
    def __init__(self, config: Any, store: Any, broker: Any) -> None:
        self._config = config
        self._store = store
        self._broker = broker
        self._worker_thread: threading.Thread | None = None
        self._worker_stop = threading.Event()

    # -- configuration --------------------------------------------------

    @property
    def forwarding_configured(self) -> bool:
        return bool(self._config.MEMFAULT_ENABLED and self._config.MEMFAULT_PROJECT_KEY)

    @property
    def read_api_configured(self) -> bool:
        return bool(
            self._config.MEMFAULT_ORG_AUTH_TOKEN
            and self._config.MEMFAULT_ORG_SLUG
            and self._config.MEMFAULT_PROJECT_SLUG
        )

    def device_serial_for(self, device: dict[str, Any]) -> str:
        smsn = provisioning.device_sidewalk_smsn(
            device.get("wireless_device_json"), device.get("provisioning_json")
        )
        if self._config.MEMFAULT_DEVICE_SERIAL_SOURCE == "wireless_device_id":
            return device.get("wireless_device_id") or smsn or ""
        return smsn or device.get("wireless_device_id") or ""

    def dashboard_url_for_serial(self, device_serial: str | None) -> str | None:
        if not device_serial or not (self._config.MEMFAULT_ORG_SLUG and self._config.MEMFAULT_PROJECT_SLUG):
            return None
        # Unverified against a live API: assumed stable Memfault web UI
        # device-detail URL pattern. Adjust once real project credentials exist.
        return (
            "https://app.memfault.com/organizations/"
            f"{self._config.MEMFAULT_ORG_SLUG}/projects/{self._config.MEMFAULT_PROJECT_SLUG}"
            f"/devices/{device_serial}/"
        )

    # -- ingest: called synchronously from a broker hook -----------------

    def enqueue_chunk_from_event(self, event: dict[str, Any]) -> int | None:
        """Persist a chunk detected on the MQTT thread for later forwarding.

        Called from an EventBroker hook, so this only does a local sqlite
        write, never network I/O (broker hooks run synchronously in publish()).
        """
        if not self._config.MEMFAULT_ENABLED:
            return None

        wireless_device_id = event.get("wireless_device_id")
        if not wireless_device_id:
            return None

        chunk_hex = event.get("memfault_chunk_hex") or ""
        try:
            chunk_bytes = bytes.fromhex(chunk_hex)
        except ValueError:
            LOGGER.warning("Dropping Memfault chunk for %s: chunk hex was invalid", wireless_device_id)
            return None

        device = self._store.device_by_wireless_id_full(wireless_device_id)
        device_serial = self.device_serial_for(device) if device else wireless_device_id
        if not device_serial:
            LOGGER.warning("Dropping Memfault chunk for %s: no usable device serial", wireless_device_id)
            return None

        sequence = event.get("memfault_sequence")
        chunk_id = self._store.enqueue_memfault_chunk(
            wireless_device_id=wireless_device_id,
            device_serial=device_serial,
            sequence=int(sequence) if sequence is not None else 0,
            chunk_data=chunk_bytes,
            message_log_id=event.get("log_id"),
        )
        self._store.upsert_memfault_device_health(
            wireless_device_id=wireless_device_id,
            device_serial=device_serial,
            last_chunk_at=event.get("ts"),
        )
        return chunk_id

    # -- background forwarder --------------------------------------------

    def start(self) -> None:
        """Start the chunk forwarder daemon thread.

        Follows the same pattern as SidewalkCloudService's MQTT listener: one
        daemon thread, safe under the single gunicorn worker this app runs.
        """
        if self._worker_thread and self._worker_thread.is_alive():
            return
        self._worker_stop.clear()
        self._worker_thread = threading.Thread(
            target=self._worker_main,
            name="memfault-chunk-forwarder",
            daemon=True,
        )
        self._worker_thread.start()

    def stop(self) -> None:
        self._worker_stop.set()

    def _worker_main(self) -> None:
        while not self._worker_stop.is_set():
            handled = False
            if self.forwarding_configured:
                try:
                    handled = self._drain_one()
                except Exception:
                    LOGGER.exception("Memfault chunk forwarder iteration failed")
            wait_secs = 0.2 if handled else self._config.MEMFAULT_WORKER_POLL_SECS
            if self._worker_stop.wait(wait_secs):
                break

    def _drain_one(self) -> bool:
        chunk = self._store.next_memfault_chunk_to_send()
        if chunk is None:
            return False

        ok, status_code, error = self._post_chunk(chunk["device_serial"], chunk["chunk_data"])
        if ok:
            self._store.mark_memfault_chunk_sent(chunk["id"])
            self._store.upsert_memfault_device_health(
                wireless_device_id=chunk["wireless_device_id"],
                device_serial=chunk["device_serial"],
                last_forward_ok=True,
                last_forward_error=None,
            )
            # Broker hooks run synchronously in publish(); this call only
            # builds a dict, no I/O happens on the listener that receives it.
            self._broker.publish(
                {
                    "type": "memfault_forwarded",
                    "wireless_device_id": chunk["wireless_device_id"],
                    "device_serial": chunk["device_serial"],
                    "sequence": chunk["sequence"],
                    "chunk_len": len(chunk["chunk_data"]),
                    "status_code": status_code,
                    "dashboard_url": self.dashboard_url_for_serial(chunk["device_serial"]),
                }
            )
            return True

        attempts = chunk["attempts"] + 1
        terminal = attempts >= self._config.MEMFAULT_CHUNK_MAX_ATTEMPTS
        backoff_secs = min(2**attempts, self._config.MEMFAULT_CHUNK_MAX_BACKOFF_SECS)
        self._store.mark_memfault_chunk_attempt_failed(
            chunk["id"],
            attempts=attempts,
            error=error,
            terminal=terminal,
            backoff_secs=backoff_secs,
        )
        self._store.upsert_memfault_device_health(
            wireless_device_id=chunk["wireless_device_id"],
            device_serial=chunk["device_serial"],
            last_forward_ok=False,
            last_forward_error=error,
        )
        return True

    def _post_chunk(self, device_serial: str, chunk_data: bytes) -> tuple[bool, int | None, str | None]:
        url = f"{self._config.MEMFAULT_CHUNKS_BASE_URL.rstrip('/')}/api/v0/chunks/{device_serial}"
        try:
            response = requests.post(
                url,
                data=chunk_data,
                headers={
                    "Memfault-Project-Key": self._config.MEMFAULT_PROJECT_KEY,
                    "Content-Type": "application/octet-stream",
                },
                timeout=self._config.MEMFAULT_HTTP_TIMEOUT_SECS,
            )
        except requests.RequestException as exc:
            return False, None, str(exc)

        if response.status_code == CHUNKS_UPLOAD_SUCCESS_STATUS:
            return True, response.status_code, None
        return False, response.status_code, f"HTTP {response.status_code}: {response.text[:200]}"

    # -- read API (device health) -----------------------------------------

    def device_health(self, device: dict[str, Any]) -> dict[str, Any]:
        """Normalized Memfault health for one device, tolerant of a missing API."""
        wireless_device_id = device.get("wireless_device_id")
        device_serial = self.device_serial_for(device)
        cached = self._store.get_memfault_device_health(wireless_device_id) if wireless_device_id else None

        result: dict[str, Any] = {
            "configured": self.read_api_configured,
            "forwardingEnabled": self.forwarding_configured,
            "deviceSerial": device_serial or None,
            "dashboardUrl": self.dashboard_url_for_serial(device_serial),
            "lastChunkAt": cached.get("last_chunk_at") if cached else None,
            "lastForwardOk": cached.get("last_forward_ok") if cached else None,
            "lastForwardError": cached.get("last_forward_error") if cached else None,
        }

        if not self.read_api_configured or not device_serial:
            return result

        live = self._fetch_device_health(device_serial)
        for key, value in live.items():
            if key not in ("configured", "device_serial"):
                result[key] = value
        return result

    def _api_base(self) -> str:
        return (
            f"{self._config.MEMFAULT_API_BASE_URL.rstrip('/')}/api/v0/organizations/"
            f"{self._config.MEMFAULT_ORG_SLUG}/projects/{self._config.MEMFAULT_PROJECT_SLUG}"
        )

    def _api_headers(self) -> dict[str, str]:
        # Unverified against a live API: assumes bearer-token auth for the
        # organization auth token, matching Memfault's published REST docs.
        return {"Authorization": f"Bearer {self._config.MEMFAULT_ORG_AUTH_TOKEN}"}

    def _fetch_device_health(self, device_serial: str) -> dict[str, Any]:
        result: dict[str, Any] = {}

        # Field mapping confirmed against a live project. The device detail
        # response nests hardware_version as an object and reports the software
        # version under last_seen_software_version, which stays null until an
        # event carrying software info has been processed.
        try:
            response = requests.get(
                f"{self._api_base()}/devices/{device_serial}",
                headers=self._api_headers(),
                timeout=self._config.MEMFAULT_HTTP_TIMEOUT_SECS,
            )
            if response.ok:
                body = response.json()
                LOGGER.debug("Memfault device response for %s: %r", device_serial, body)
                data = body.get("data") if isinstance(body, dict) else None
                if not isinstance(data, dict):
                    data = body if isinstance(body, dict) else {}
                result["lastSeen"] = data.get("last_seen") or data.get("updated_date")
                result["firstSeen"] = data.get("first_seen")
                result["softwareVersion"] = _name_of(data.get("last_seen_software_version"))
                result["hardwareVersion"] = _name_of(data.get("hardware_version"))
                result["cohort"] = _name_of(data.get("cohort"))
                nickname = data.get("nickname")
                result["nickname"] = nickname or None
            else:
                result["error"] = f"HTTP {response.status_code}"
        except requests.RequestException as exc:
            result["error"] = str(exc)

        # Unverified against a live API: endpoint path and shape assumed from
        # Memfault's public reboot-reason endpoint docs.
        try:
            response = requests.get(
                f"{self._api_base()}/devices/{device_serial}/reboots",
                headers=self._api_headers(),
                params={"per_page": 5},
                timeout=self._config.MEMFAULT_HTTP_TIMEOUT_SECS,
            )
            if response.ok:
                body = response.json()
                LOGGER.debug("Memfault reboots response for %s: %r", device_serial, body)
                items = body.get("data") if isinstance(body, dict) else None
                result["recentRebootCount"] = len(items) if isinstance(items, list) else None
        except requests.RequestException as exc:
            result.setdefault("error", str(exc))

        return result

    def test_project_key(self) -> dict[str, Any]:
        """Check the project key against the chunks endpoint without ingesting data.

        Posts an empty body. Memfault checks the Memfault-Project-Key header
        before it validates the body, so a good key answers 411 (Content-Length
        must be positive) and a bad one answers 403. That makes this a probe
        that proves the credential without pushing junk chunks into the project.
        """
        if not self._config.MEMFAULT_PROJECT_KEY:
            return {"ok": False, "error": "MEMFAULT_PROJECT_KEY is not set"}

        url = f"{self._config.MEMFAULT_CHUNKS_BASE_URL.rstrip('/')}/api/v0/chunks/connectivity-probe"
        try:
            response = requests.post(
                url,
                headers={
                    "Memfault-Project-Key": self._config.MEMFAULT_PROJECT_KEY,
                    "Content-Type": "application/octet-stream",
                },
                data=b"",
                timeout=self._config.MEMFAULT_HTTP_TIMEOUT_SECS,
            )
        except requests.RequestException as exc:
            return {"ok": False, "error": str(exc)}

        if response.status_code == 411:
            return {"ok": True, "statusCode": 411, "error": None}
        if response.status_code in (401, 403):
            return {"ok": False, "statusCode": response.status_code,
                    "error": "Project key rejected by Memfault"}
        # Anything else still means the key was accepted, since auth is checked first.
        return {"ok": response.status_code < 400, "statusCode": response.status_code,
                "error": None if response.status_code < 400 else f"HTTP {response.status_code}"}

    def test_connectivity(self) -> dict[str, Any]:
        """Admin connectivity probe covering both the write and read paths."""
        result: dict[str, Any] = {"projectKey": self.test_project_key()}

        if not self.read_api_configured:
            result["readApi"] = {
                "ok": False,
                "configured": False,
                "error": "Set MEMFAULT_ORG_AUTH_TOKEN, MEMFAULT_ORG_SLUG, and MEMFAULT_PROJECT_SLUG to read health back",
            }
            # The write path is what makes the demo send data, so it decides ok.
            result["ok"] = result["projectKey"].get("ok", False)
            return result

        # Unverified against a live API: the project root is used only as a
        # lightweight authenticated probe, not a documented health check.
        try:
            response = requests.get(
                self._api_base(),
                headers=self._api_headers(),
                timeout=self._config.MEMFAULT_HTTP_TIMEOUT_SECS,
            )
        except requests.RequestException as exc:
            return {"ok": False, "error": str(exc)}

        read_ok = response.status_code < 400
        result["readApi"] = {
            "ok": read_ok,
            "configured": True,
            "statusCode": response.status_code,
            "error": None if read_ok else f"HTTP {response.status_code}",
        }
        result["ok"] = result["projectKey"].get("ok", False) and read_ok
        return result
