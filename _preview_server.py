"""Throwaway preview server: renders the real templates with mock data so the
UI can be screenshotted without AWS credentials. Not part of the app."""
from flask import Flask, render_template

app = Flask(__name__, template_folder="templates", static_folder="static")
app.secret_key = "preview"

# --- Stub endpoints so url_for(...) resolves in the templates ---
def _noop():
    return ""

for ep, rule in [
    ("logout", "/logout"),
    ("admin", "/admin"),
    ("dashboard", "/"),
    ("login", "/login"),
    ("create_customer", "/admin/customers"),
    ("create_device", "/admin/devices"),
    ("import_device", "/admin/devices/import"),
]:
    app.add_url_rule(rule, ep, _noop)

for ep, rule in [
    ("update_customer_permissions", "/admin/customers/<int:customer_id>/permissions"),
    ("assign_device", "/admin/devices/<int:device_id>/assign"),
    ("refresh_device", "/admin/devices/<int:device_id>/refresh"),
    ("download_certificate_json", "/admin/devices/<int:device_id>/certificate.json"),
    ("download_wireless_device_json", "/admin/devices/<int:device_id>/wireless_device.json"),
    ("download_device_profile_json", "/admin/devices/<int:device_id>/device_profile.json"),
    ("download_mfg_bin", "/admin/devices/<int:device_id>/mfg.bin"),
    ("download_mfg_hex", "/admin/devices/<int:device_id>/mfg.hex"),
]:
    app.add_url_rule(rule, ep, _noop)


PAGE_CONFIG = {
    "user": {"email": "operator@pilot.io", "displayName": "Pilot Operator", "role": "admin"},
    "devices": [
        {"id": 1, "name": "Water Heater 01", "customerName": "Pilot Account"},
        {"id": 2, "name": "Water Heater 02", "customerName": "Pilot Account"},
        {"id": 3, "name": "Field Sensor A", "customerName": "Acme Field Ops"},
    ],
    "selectedDeviceId": 1,
    "selectedWirelessDeviceId": "9f3c1d20-7a4b-4c11-9b2e-2f8a1c0d5e66",
    "selectedDeviceName": "Water Heater 01",
    "selectedUplinkTopic": "sidewalk/app/uplink/9f3c1d20",
    "nusServiceUuid": "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
    "nusRxUuid": "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
    "nusTxUuid": "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
    "sidewalkBleServiceUuid": "0000fe03-0000-1000-8000-00805f9b34fb",
    "sidewalkBleWriteUuid": "74f996c9-7d6c-4d58-9232-0427ab61c53c",
    "sidewalkBleNotifyUuid": "b32e83c0-fece-47c1-9015-53b7e7f0d2fe",
    "webShellNamePrefix": "WebShell",
    "adminUrl": "/admin",
    "canProvisionFirmware": True,
    "mfgStorageAddress": "0x000FF000",
    "firmwareImages": [
        {"id": "xiao-web-demo", "name": "XIAO Web Demo (release)"},
        {"id": "xiao-web-demo-debug", "name": "XIAO Web Demo (debug)"},
    ],
}

CUSTOMERS = [
    {"id": 1, "display_name": "Pilot Account", "email": "pilot@pilot.io", "device_count": 2,
     "can_provision": True, "created_at": "2026-05-01 09:12", "last_login_at": "2026-06-14 08:30"},
    {"id": 2, "display_name": "Acme Field Ops", "email": "ops@acme.example", "device_count": 1,
     "can_provision": False, "created_at": "2026-05-20 14:02", "last_login_at": None},
]

DEVICES = [
    {"id": 1, "name": "Water Heater 01", "customer_ids": [1], "customer_name": "Pilot Account",
     "wireless_device_id": "9f3c1d20-7a4b-4c11-9b2e-2f8a1c0d5e66",
     "uplink_topic": "sidewalk/app/uplink/9f3c1d20", "device_profile_id": "a1b2c3d4-prof"},
    {"id": 2, "name": "Water Heater 02", "customer_ids": [1], "customer_name": "Pilot Account",
     "wireless_device_id": "5e2a99af-3b1c-44d0-8f6a-7c9e0b2d1a33",
     "uplink_topic": "sidewalk/app/uplink/5e2a99af", "device_profile_id": "a1b2c3d4-prof"},
    {"id": 3, "name": "Field Sensor A", "customer_ids": [2], "customer_name": "Acme Field Ops",
     "wireless_device_id": "11223344-aaaa-bbbb-cccc-ddddeeeeffff",
     "uplink_topic": "sidewalk/app/uplink/11223344", "device_profile_id": "a1b2c3d4-prof"},
]


@app.route("/")
def home():
    return render_template("dashboard.html", page_config=PAGE_CONFIG)


@app.route("/admin")
def admin_view():
    return render_template(
        "admin.html",
        user={"email": "operator@pilot.io"},
        customers=CUSTOMERS,
        devices=DEVICES,
        default_destination_name="SidewalkDestination",
        default_device_profile_id="a1b2c3d4-prof",
        default_uplink_topic="sidewalk/app/uplink",
    )


@app.route("/login")
def login_view():
    return render_template("login.html", error=None, saved_email="")


# Override stub endpoints we actually want to render
app.view_functions["dashboard"] = home
app.view_functions["admin"] = admin_view
app.view_functions["login"] = login_view


if __name__ == "__main__":
    app.run(port=8055, debug=False)
