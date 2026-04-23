from __future__ import annotations

import json
import logging
import os
import queue
import sqlite3
from datetime import timedelta
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
from storage import DemoStore


logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger(__name__)

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


def _device_summary(device: dict) -> dict:
    return {
        "id": device["id"],
        "name": device["name"],
        "wirelessDeviceId": device["wireless_device_id"],
        "uplinkTopic": device["uplink_topic"],
        "bleNamePrefix": device.get("ble_name_prefix") or "XIAO-WebShell",
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
        "webShellNamePrefix": (selected_device or {}).get("ble_name_prefix", "XIAO-WebShell"),
        "adminUrl": url_for("admin") if user["role"] == "admin" else "",
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

    if not email or not password:
        flash("Customer email and password are required.", "error")
        return redirect(url_for("admin"))

    try:
        customer = store.create_customer(email=email, password=password, display_name=display_name, notes=notes)
    except sqlite3.IntegrityError:
        flash("A customer with that email already exists.", "error")
        return redirect(url_for("admin"))

    flash(f"Created customer {customer['email']}.", "success")
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
    ble_name_prefix = request.form.get("ble_name_prefix", "").strip() or "XIAO-WebShell"

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
    ble_name_prefix = request.form.get("ble_name_prefix", "").strip() or "XIAO-WebShell"

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
