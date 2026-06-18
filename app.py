from __future__ import annotations

import json
import logging
import os
import queue
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from flask import (
    Flask,
    Response,
    abort,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from werkzeug.middleware.proxy_fix import ProxyFix

from config import DemoConfig
from iot import DownlinkRequest, EventBroker, SidewalkCloudService
from provisioning import ProvisioningError, build_sidewalk_mfg_bin, bytes_to_ihex, merge_ihex
from storage import DemoStore


logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger(__name__)

DEFAULT_WEB_SHELL_NAME_MATCH = "Nordic UART or Sidewalk BLE service"
LEGACY_WEB_SHELL_NAME_PREFIX = "XIAO-WebShell"

WEB_DEMO_ROOT = Path(__file__).resolve().parent
FLASH_IMAGE_MANIFEST = {
    "aodemo1": {
        "name": "AODemo1.hex",
        "path": WEB_DEMO_ROOT / "firmware/AODemo1.hex",
    },
    "aodemo2": {
        "name": "AODemo2.hex",
        "path": WEB_DEMO_ROOT / "firmware/AODemo2.hex",
    },
}

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.secret_key = DemoConfig.FLASK_SECRET_KEY
app.permanent_session_lifetime = timedelta(days=30)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = DemoConfig.SESSION_COOKIE_SECURE
app.config["PREFERRED_URL_SCHEME"] = "https"

store = DemoStore(DemoConfig.DATABASE_PATH)
store.init_db()
store.seed_admin(DemoConfig.ADMIN_EMAIL, DemoConfig.ADMIN_PASSWORD)
store.seed_default_device(
    wireless_device_id=DemoConfig.SIDEWALK_WIRELESS_DEVICE_ID,
    uplink_topic=DemoConfig.AWS_IOT_UPLINK_TOPIC,
    destination_name=DemoConfig.SIDEWALK_DESTINATION_NAME,
    device_profile_id=DemoConfig.SIDEWALK_DEVICE_PROFILE_ID,
)

broker = EventBroker(DemoConfig.EVENT_BACKLOG_SIZE)


def _persist_uplink(event: dict) -> None:
    """Store every uplink that carries a payload so customers can browse
    historical sensor readings (the live charts are otherwise in-memory)."""
    if event.get("type") != "uplink":
        return
    payload_json = event.get("payload_json")
    payload_hex = event.get("payload_hex")
    if not (isinstance(payload_json, dict) and payload_json) and not payload_hex:
        return
    try:
        store.record_sensor_reading(
            wireless_device_id=event.get("wireless_device_id"),
            ts=event.get("ts") or "",
            link_name=event.get("link_name"),
            payload_json=payload_json,
            payload_hex=payload_hex,
        )
    except Exception:
        LOGGER.warning("Failed to persist sensor reading", exc_info=True)


broker.add_hook(_persist_uplink)

cloud_service = SidewalkCloudService(DemoConfig, broker)
cloud_service.start(store.unique_uplink_topics())


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped


def admin_required(view):
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user or user["role"] != "admin":
            return redirect(url_for("dashboard"))
        return view(*args, **kwargs)

    return wrapped


def current_user() -> dict | None:
    user_id = session.get("user_id")
    if not user_id:
        return None
    return store.get_user(int(user_id))


def _can_provision_firmware(user: dict) -> bool:
    return user["role"] == "admin" or bool(user.get("can_provision"))


def _web_shell_name_match(value: str | None) -> str:
    return DEFAULT_WEB_SHELL_NAME_MATCH


def _device_summary(device: dict) -> dict:
    return {
        "id": device["id"],
        "name": device["name"],
        "wirelessDeviceId": device["wireless_device_id"],
        "uplinkTopic": device["uplink_topic"],
        "bleNamePrefix": _web_shell_name_match(device.get("ble_name_prefix")),
        "customerName": device.get("customer_name") or "",
        "customerEmail": device.get("customer_email") or "",
    }


def _selected_device_for_request(user: dict) -> tuple[list[dict], dict | None]:
    devices = store.list_devices_for_user(user)
    requested = request.args.get("device", "").strip()
    selected = None
    if requested:
        try:
            requested_id = int(requested)
        except ValueError:
            requested_id = -1
        for device in devices:
            if device["id"] == requested_id:
                selected = device
                break
    if selected is None and devices:
        selected = devices[0]
    return devices, selected


def _event_visible(event: dict, allowed_wireless_ids: set[str], selected_wireless_id: str | None) -> bool:
    event_wireless_id = event.get("wireless_device_id")
    if event_wireless_id and event_wireless_id not in allowed_wireless_ids:
        return False
    if selected_wireless_id and event_wireless_id and event_wireless_id != selected_wireless_id:
        return False
    return True


def _sync_topics() -> None:
    cloud_service.sync_topics(store.unique_uplink_topics())


def _available_firmware_images() -> list[dict]:
    images = []
    for image_id, entry in FLASH_IMAGE_MANIFEST.items():
        path = entry["path"]
        if not path.is_file():
            LOGGER.warning("Firmware image missing from dashboard manifest: %s", path)
            continue
        images.append(
            {
                "id": image_id,
                "name": entry["name"],
                "sizeBytes": path.stat().st_size,
                "downloadUrl": url_for("firmware_image", image_id=image_id),
            }
        )
    return images


def _load_or_refresh_artifacts(device: dict) -> tuple[dict, dict, dict]:
    wireless_device_json = device.get("wireless_device_json")
    device_profile_json = device.get("device_profile_json")
    provisioning_json = device.get("provisioning_json")

    if wireless_device_json and device_profile_json and provisioning_json:
        return wireless_device_json, device_profile_json, provisioning_json

    if not device.get("device_profile_id"):
        raise ValueError("Device profile ID is required to fetch provisioning artifacts")

    wireless_device_json, device_profile_json, provisioning_json = cloud_service.refresh_device_artifacts(
        wireless_device_id=device["wireless_device_id"],
        device_profile_id=device["device_profile_id"],
    )
    store.update_device_artifacts(
        device["id"],
        wireless_device_json=wireless_device_json,
        device_profile_json=device_profile_json,
        provisioning_json=provisioning_json,
    )
    return wireless_device_json, device_profile_json, provisioning_json


def _mfg_hex_for_device(device: dict) -> str:
    wireless_device_json, device_profile_json, _ = _load_or_refresh_artifacts(device)
    mfg_bin = build_sidewalk_mfg_bin(wireless_device_json, device_profile_json)
    return bytes_to_ihex(mfg_bin, DemoConfig.SIDEWALK_MFG_STORAGE_ADDRESS)


def _download_filename(*parts: str) -> str:
    raw = "-".join(part for part in parts if part)
    filename = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in raw)
    return filename.strip("_") or "download"


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("user_id"):
        return redirect(url_for("dashboard"))

    error = None
    saved_email = request.cookies.get("demo_email", "")
    if request.method == "POST":
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")
        result = store.authenticate_user(email, password)
        if result.ok and result.user:
            user = result.user
            session.permanent = True
            session["user_id"] = user["id"]
            session["role"] = user["role"]
            session["email"] = user["email"]
            response = redirect(url_for("dashboard"))
            response.set_cookie(
                "demo_email",
                user["email"],
                max_age=int(timedelta(days=30).total_seconds()),
                samesite="Lax",
            )
            return response
        error = result.error or "Invalid credentials"
        saved_email = email

    return render_template("login.html", error=error, saved_email=saved_email)


@app.post("/logout")
@login_required
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/")
@login_required
def dashboard():
    user = current_user()
    assert user is not None

    devices, selected_device = _selected_device_for_request(user)
    page_config = {
        "user": {
            "email": user["email"],
            "displayName": user.get("display_name") or user["email"],
            "role": user["role"],
        },
        "devices": [_device_summary(device) for device in devices],
        "selectedDeviceId": selected_device["id"] if selected_device else None,
        "selectedWirelessDeviceId": selected_device["wireless_device_id"] if selected_device else "",
        "selectedDeviceName": selected_device["name"] if selected_device else "",
        "selectedUplinkTopic": selected_device["uplink_topic"] if selected_device else "",
        "nusServiceUuid": DemoConfig.NUS_SERVICE_UUID,
        "nusRxUuid": DemoConfig.NUS_RX_UUID,
        "nusTxUuid": DemoConfig.NUS_TX_UUID,
        "sidewalkBleServiceUuid": DemoConfig.SIDEWALK_BLE_SERVICE_UUID,
        "sidewalkBleWriteUuid": DemoConfig.SIDEWALK_BLE_WRITE_UUID,
        "sidewalkBleNotifyUuid": DemoConfig.SIDEWALK_BLE_NOTIFY_UUID,
        "webShellNamePrefix": DEFAULT_WEB_SHELL_NAME_MATCH,
        "adminUrl": url_for("admin") if user["role"] == "admin" else "",
        "canProvisionFirmware": _can_provision_firmware(user),
        "mfgStorageAddress": DemoConfig.SIDEWALK_MFG_STORAGE_ADDRESS,
        "firmwareImages": _available_firmware_images(),
    }
    return render_template("dashboard.html", page_config=page_config)


@app.get("/firmware-images/<image_id>")
@login_required
def firmware_image(image_id: str):
    entry = FLASH_IMAGE_MANIFEST.get(image_id)
    if entry is None:
        abort(404)

    path = entry["path"]
    if not path.is_file():
        abort(404)

    if request.args.get("provision") == "1":
        user = current_user()
        assert user is not None
        if not _can_provision_firmware(user):
            abort(403)

        try:
            device_id = int(request.args.get("device_id", ""))
        except ValueError:
            abort(400)

        device = store.get_device_for_user(user, device_id)
        if device is None:
            abort(404)

        try:
            base_hex = path.read_text(encoding="utf-8")
            mfg_hex = _mfg_hex_for_device(device)
            provisioned_hex = merge_ihex(base_hex, mfg_hex)
        except ProvisioningError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception as exc:
            LOGGER.exception("Failed to build provisioned firmware")
            return jsonify({"ok": False, "error": str(exc)}), 400

        filename = _download_filename(device["name"], entry["name"])
        return Response(
            provisioned_hex,
            mimetype="text/plain; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    return send_file(
        path,
        mimetype="text/plain; charset=utf-8",
        download_name=entry["name"],
        max_age=0,
    )


@app.get("/admin")
@admin_required
def admin():
    user = current_user()
    assert user is not None
    return render_template(
        "admin.html",
        user=user,
        customers=store.list_customers(),
        devices=store.list_all_devices(),
        default_destination_name=DemoConfig.SIDEWALK_DESTINATION_NAME,
        default_device_profile_id=DemoConfig.SIDEWALK_DEVICE_PROFILE_ID,
        default_uplink_topic=DemoConfig.AWS_IOT_UPLINK_TOPIC,
    )


@app.post("/admin/customers")
@admin_required
def create_customer():
    email = request.form.get("email", "").strip()
    password = request.form.get("password", "")
    display_name = request.form.get("display_name", "").strip()
    notes = request.form.get("notes", "").strip()
    can_provision = request.form.get("can_provision") == "1"

    if not email or not password:
        flash("Customer email and password are required.", "error")
        return redirect(url_for("admin"))

    try:
        customer = store.create_customer(
            email=email,
            password=password,
            display_name=display_name,
            notes=notes,
            can_provision=can_provision,
        )
    except sqlite3.IntegrityError:
        flash("A customer with that email already exists.", "error")
        return redirect(url_for("admin"))

    flash(f"Created customer {customer['email']}.", "success")
    return redirect(url_for("admin"))


@app.post("/admin/customers/<int:customer_id>/permissions")
@admin_required
def update_customer_permissions(customer_id: int):
    customer = store.get_user(customer_id)
    if customer is None or customer["role"] != "customer":
        flash("Customer not found.", "error")
        return redirect(url_for("admin"))

    can_provision = request.form.get("can_provision") == "1"
    store.update_customer_permissions(customer_id, can_provision=can_provision)
    flash(f"Updated permissions for {customer.get('display_name') or customer['email']}.", "success")
    return redirect(url_for("admin"))


@app.post("/admin/devices/import")
@admin_required
def import_device():
    customer_user_id = request.form.get("customer_user_id", "").strip()
    device_profile_id = request.form.get("device_profile_id", "").strip()
    wireless_device_id = request.form.get("wireless_device_id", "").strip()
    name = request.form.get("name", "").strip()
    description = request.form.get("description", "").strip()
    destination_name = request.form.get("destination_name", "").strip()
    uplink_topic = request.form.get("uplink_topic", "").strip()
    ble_name_prefix = request.form.get("ble_name_prefix", "").strip() or DEFAULT_WEB_SHELL_NAME_MATCH

    if not name or not wireless_device_id:
        flash("Imported devices need a name and WirelessDeviceId.", "error")
        return redirect(url_for("admin"))

    customer_id = int(customer_user_id) if customer_user_id else None
    wireless_device_json = None
    device_profile_json = None
    provisioning_json = None
    if device_profile_id:
        try:
            wireless_device_json, device_profile_json, provisioning_json = cloud_service.refresh_device_artifacts(
                wireless_device_id=wireless_device_id,
                device_profile_id=device_profile_id,
            )
        except Exception as exc:
            flash(f"Imported device added without provisioning artifacts: {exc}", "warning")

    try:
        store.create_device_record(
            customer_user_id=customer_id,
            name=name,
            description=description,
            wireless_device_id=wireless_device_id,
            destination_name=destination_name,
            uplink_topic=uplink_topic,
            device_profile_id=device_profile_id,
            ble_name_prefix=ble_name_prefix,
            wireless_device_json=wireless_device_json,
            device_profile_json=device_profile_json,
            provisioning_json=provisioning_json,
        )
    except sqlite3.IntegrityError:
        flash("That WirelessDeviceId is already tracked.", "error")
        return redirect(url_for("admin"))

    _sync_topics()
    flash(f"Imported device {name}.", "success")
    return redirect(url_for("admin"))


@app.post("/admin/devices/create")
@admin_required
def create_device():
    customer_user_id = request.form.get("customer_user_id", "").strip()
    device_profile_id = request.form.get("device_profile_id", "").strip()
    destination_name = request.form.get("destination_name", "").strip()
    uplink_topic = request.form.get("uplink_topic", "").strip()
    name = request.form.get("name", "").strip()
    description = request.form.get("description", "").strip()
    ble_name_prefix = request.form.get("ble_name_prefix", "").strip() or DEFAULT_WEB_SHELL_NAME_MATCH

    if not all((name, destination_name, device_profile_id, uplink_topic)):
        flash("AWS Sidewalk device creation requires name, destination, profile ID, and uplink topic.", "error")
        return redirect(url_for("admin"))

    try:
        created = cloud_service.create_wireless_device(
            name=name,
            description=description,
            destination_name=destination_name,
            device_profile_id=device_profile_id,
        )
        wireless_device_json, device_profile_json, provisioning_json = cloud_service.refresh_device_artifacts(
            wireless_device_id=created["id"],
            device_profile_id=device_profile_id,
        )
        store.create_device_record(
            customer_user_id=int(customer_user_id) if customer_user_id else None,
            name=name,
            description=description,
            wireless_device_id=created["id"],
            destination_name=destination_name,
            uplink_topic=uplink_topic,
            device_profile_id=device_profile_id,
            ble_name_prefix=ble_name_prefix,
            wireless_device_json=wireless_device_json,
            device_profile_json=device_profile_json,
            provisioning_json=provisioning_json,
        )
    except sqlite3.IntegrityError:
        flash("That WirelessDeviceId is already tracked locally.", "error")
        return redirect(url_for("admin"))
    except Exception as exc:
        LOGGER.exception("Failed to create Sidewalk device")
        flash(f"Failed to create Sidewalk device: {exc}", "error")
        return redirect(url_for("admin"))

    _sync_topics()
    flash(f"Created AWS Sidewalk device {name}.", "success")
    return redirect(url_for("admin"))


@app.post("/admin/devices/<int:device_id>/refresh")
@admin_required
def refresh_device(device_id: int):
    device = store.get_device(device_id)
    if device is None:
        flash("Device not found.", "error")
        return redirect(url_for("admin"))

    try:
        _load_or_refresh_artifacts(device)
    except Exception as exc:
        flash(f"Failed to refresh device artifacts: {exc}", "error")
        return redirect(url_for("admin"))

    flash(f"Refreshed provisioning data for {device['name']}.", "success")
    return redirect(url_for("admin"))


@app.get("/admin/devices/<int:device_id>/mfg.bin")
@admin_required
def download_mfg_bin(device_id: int):
    device = store.get_device(device_id)
    if device is None:
        return jsonify({"ok": False, "error": "Device not found"}), 404
    try:
        wireless_device_json, device_profile_json, _ = _load_or_refresh_artifacts(device)
        mfg_bin = build_sidewalk_mfg_bin(wireless_device_json, device_profile_json)
    except ProvisioningError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        LOGGER.exception("Failed to build manufacturing binary")
        return jsonify({"ok": False, "error": str(exc)}), 400
    return Response(
        mfg_bin,
        mimetype="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{_download_filename(device["name"], "mfg.bin")}"'},
    )


@app.get("/admin/devices/<int:device_id>/mfg.hex")
@admin_required
def download_mfg_hex(device_id: int):
    device = store.get_device(device_id)
    if device is None:
        return jsonify({"ok": False, "error": "Device not found"}), 404
    try:
        mfg_hex = _mfg_hex_for_device(device)
    except ProvisioningError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    except Exception as exc:
        LOGGER.exception("Failed to build manufacturing hex")
        return jsonify({"ok": False, "error": str(exc)}), 400
    return Response(
        mfg_hex,
        mimetype="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{_download_filename(device["name"], "mfg.hex")}"'},
    )


@app.post("/admin/devices/<int:device_id>/assign")
@admin_required
def assign_device(device_id: int):
    device = store.get_device(device_id)
    if device is None:
        flash("Device not found.", "error")
        return redirect(url_for("admin"))

    customer_user_ids = request.form.getlist("customer_user_ids")
    customer_ids = []
    customer_labels = []

    for customer_user_id in customer_user_ids:
        try:
            customer_id = int(customer_user_id)
        except ValueError:
            flash("Select a valid customer.", "error")
            return redirect(url_for("admin"))

        customer = store.get_user(customer_id)
        if customer is None or customer["role"] != "customer":
            flash("Select a valid customer.", "error")
            return redirect(url_for("admin"))
        customer_ids.append(customer_id)
        customer_labels.append(customer.get("display_name") or customer["email"])

    store.update_device_customers(device_id, customer_ids)
    customer_label = ", ".join(customer_labels) if customer_labels else "no customers"
    flash(f"Assigned {device['name']} to {customer_label}.", "success")
    return redirect(url_for("admin"))


def _json_download(payload: dict, filename: str) -> Response:
    return Response(
        json.dumps(payload, indent=2),
        mimetype="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/admin/devices/<int:device_id>/certificate.json")
@admin_required
def download_certificate_json(device_id: int):
    device = store.get_device(device_id)
    if device is None:
        return jsonify({"ok": False, "error": "Device not found"}), 404
    _, _, provisioning_json = _load_or_refresh_artifacts(device)
    return _json_download(provisioning_json, f"{device['name']}-certificate.json")


@app.get("/admin/devices/<int:device_id>/wireless-device.json")
@admin_required
def download_wireless_device_json(device_id: int):
    device = store.get_device(device_id)
    if device is None:
        return jsonify({"ok": False, "error": "Device not found"}), 404
    wireless_device_json, _, _ = _load_or_refresh_artifacts(device)
    return _json_download(wireless_device_json, f"{device['name']}-wireless-device.json")


@app.get("/admin/devices/<int:device_id>/device-profile.json")
@admin_required
def download_device_profile_json(device_id: int):
    device = store.get_device(device_id)
    if device is None:
        return jsonify({"ok": False, "error": "Device not found"}), 404
    _, device_profile_json, _ = _load_or_refresh_artifacts(device)
    return _json_download(device_profile_json, f"{device['name']}-device-profile.json")


@app.get("/api/events")
@login_required
def events():
    user = current_user()
    assert user is not None
    devices = store.list_devices_for_user(user)
    allowed_wireless_ids = {device["wireless_device_id"] for device in devices}

    selected_wireless_id = ""
    requested_device_id = request.args.get("device", "").strip()
    if requested_device_id:
        try:
            selected = store.get_device_for_user(user, int(requested_device_id))
        except ValueError:
            selected = None
        if selected:
            selected_wireless_id = selected["wireless_device_id"]

    listener, history = broker.open_stream()

    def stream():
        try:
            yield "retry: 3000\n\n"
            for event in history:
                if _event_visible(event, allowed_wireless_ids, selected_wireless_id or None):
                    yield f"data: {json.dumps(event)}\n\n"
            while True:
                try:
                    event = listener.get(timeout=20)
                except queue.Empty:
                    yield "event: ping\ndata: {}\n\n"
                    continue
                if _event_visible(event, allowed_wireless_ids, selected_wireless_id or None):
                    yield f"data: {json.dumps(event)}\n\n"
        finally:
            broker.close_stream(listener)

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }
    return Response(stream(), mimetype="text/event-stream", headers=headers)


SENSOR_HISTORY_RANGES = {
    "hour": timedelta(hours=1),
    "day": timedelta(days=1),
    "week": timedelta(weeks=1),
    "month": timedelta(days=30),
    "year": timedelta(days=365),
}
SENSOR_HISTORY_MAX_POINTS = 600


def _decimate(rows: list, max_points: int) -> list:
    """Evenly sample ``rows`` down to ``max_points``, always keeping the most
    recent reading, so a wide range still renders a faithful chart shape."""
    count = len(rows)
    if count <= max_points or max_points <= 0:
        return rows
    step = count / max_points
    sampled = [rows[int(i * step)] for i in range(max_points)]
    if sampled[-1] is not rows[-1]:
        sampled.append(rows[-1])
    return sampled


@app.get("/api/sensor-history")
@login_required
def sensor_history():
    user = current_user()
    assert user is not None

    range_key = request.args.get("range", "day").strip().lower()
    delta = SENSOR_HISTORY_RANGES.get(range_key)
    if delta is None:
        return jsonify({"ok": False, "error": "Unknown range"}), 400

    requested_device_id = request.args.get("device", "").strip()
    device = None
    if requested_device_id:
        try:
            device = store.get_device_for_user(user, int(requested_device_id))
        except ValueError:
            device = None
    if device is None:
        return jsonify({"ok": False, "error": "Device not found"}), 404

    since_iso = (datetime.now(timezone.utc) - delta).isoformat(timespec="seconds")
    readings = _decimate(
        store.sensor_readings(device["wireless_device_id"], since_iso),
        SENSOR_HISTORY_MAX_POINTS,
    )
    events = [
        {
            "type": "uplink",
            "ts": reading["ts"],
            "link_name": reading.get("link_name"),
            "payload_json": reading.get("payload_json"),
            "payload_hex": reading.get("payload_hex") or "",
        }
        for reading in readings
    ]
    return jsonify({"ok": True, "range": range_key, "count": len(events), "events": events})


@app.post("/api/downlink")
@login_required
def downlink():
    user = current_user()
    assert user is not None

    body = request.get_json(force=True, silent=False)
    payload = (body.get("payload") or "").strip()
    acked = bool(body.get("acked", True))
    message_type = body.get("messageType") or "CUSTOM_COMMAND_ID_NOTIFY"
    seq = body.get("seq")
    device_id = body.get("deviceId")

    try:
        device = store.get_device_for_user(user, int(device_id))
    except (TypeError, ValueError):
        device = None

    if device is None:
        return jsonify({"ok": False, "error": "Select a valid device first"}), 400

    try:
        request_obj = DownlinkRequest(
            text=payload,
            wireless_device_id=device["wireless_device_id"],
            device_name=device["name"],
            message_type=message_type,
            acked=acked,
            seq=int(seq) if seq not in (None, "") else None,
        )
        event = cloud_service.send_downlink(request_obj)
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    return jsonify({"ok": True, "event": event})


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8000")), debug=False)
