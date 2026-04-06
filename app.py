import json
import logging
import os
import queue
from datetime import timedelta
from functools import wraps

from flask import Flask, Response, jsonify, redirect, render_template, request, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

from config import DemoConfig
from iot import DownlinkRequest, EventBroker, SidewalkCloudService


logging.basicConfig(level=logging.INFO)

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.secret_key = DemoConfig.FLASK_SECRET_KEY
app.permanent_session_lifetime = timedelta(days=30)
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = DemoConfig.SESSION_COOKIE_SECURE
app.config["PREFERRED_URL_SCHEME"] = "https"

broker = EventBroker(DemoConfig.EVENT_BACKLOG_SIZE)
cloud_service = SidewalkCloudService(DemoConfig, broker)
cloud_service.start()


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("authenticated"):
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("authenticated"):
        return redirect(url_for("dashboard"))

    error = None
    saved_email = request.cookies.get("demo_email", "")
    if request.method == "POST":
        email = request.form.get("email", "")
        password = request.form.get("password", "")
        if email == DemoConfig.LOGIN_EMAIL and password == DemoConfig.LOGIN_PASSWORD:
            session.permanent = True
            session["authenticated"] = True
            session["email"] = email
            response = redirect(url_for("dashboard"))
            response.set_cookie(
                "demo_email",
                email,
                max_age=int(timedelta(days=30).total_seconds()),
                samesite="Lax",
            )
            return response
        error = "Invalid credentials"
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
    page_config = {
        "deviceId": DemoConfig.SIDEWALK_WIRELESS_DEVICE_ID,
        "uplinkTopic": DemoConfig.AWS_IOT_UPLINK_TOPIC,
        "nusServiceUuid": DemoConfig.NUS_SERVICE_UUID,
        "nusRxUuid": DemoConfig.NUS_RX_UUID,
        "nusTxUuid": DemoConfig.NUS_TX_UUID,
        "webShellNamePrefix": "XIAO-WebShell",
    }
    return render_template("dashboard.html", page_config=page_config)


@app.get("/api/events")
@login_required
def events():
    listener, history = broker.open_stream()

    def stream():
        try:
            yield "retry: 3000\n\n"
            for event in history:
                yield f"data: {json.dumps(event)}\n\n"
            while True:
                try:
                    event = listener.get(timeout=20)
                except queue.Empty:
                    yield "event: ping\ndata: {}\n\n"
                    continue
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
    body = request.get_json(force=True, silent=False)
    payload = (body.get("payload") or "").strip()
    acked = bool(body.get("acked", True))
    message_type = body.get("messageType") or "CUSTOM_COMMAND_ID_NOTIFY"
    seq = body.get("seq")

    try:
        request_obj = DownlinkRequest(
            text=payload,
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
