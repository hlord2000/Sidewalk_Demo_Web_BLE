# Sidewalk Web Demo

Flask web app for a Sidewalk device demo:

- login-gated dashboard
- Sidewalk cloud downlink sends via AWS IoT Wireless
- live uplink monitoring via AWS IoT MQTT over SSE
- Web Bluetooth shell over Nordic UART Service

## Repo Layout

- `app.py`: Flask entry point
- `config.py`: environment-variable based runtime config
- `iot.py`: AWS IoT Wireless downlink + MQTT uplink bridge
- `templates/`, `static/`: UI
- `railway.json`: Railway start and health-check config
- `.env.example`: required environment variables

## Local Run

```sh
cd tools/web_demo
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Populate `.env`, then:

```sh
set -a
source .env
set +a
python app.py
```

The app listens on `0.0.0.0:${PORT:-8000}`.

## Required Environment Variables

Set these at minimum:

- `FLASK_SECRET_KEY`
- `LOGIN_EMAIL`
- `LOGIN_PASSWORD`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_IOT_ENDPOINT`
- `AWS_IOT_UPLINK_TOPIC`
- `SIDEWALK_WIRELESS_DEVICE_ID`

Usually keep these too:

- `AWS_REGION=us-east-1`
- `SESSION_COOKIE_SECURE=true`
- `MQTT_CLIENT_ID=sidewalk-web-demo`

The NUS UUIDs already default to Nordic UART Service and usually do not need changes.

## Git Repo

This folder can still be deployed as its own repo root if you want to split the
web service out later.

```sh
cd tools/web_demo
git init -b main
git add .
git commit -m "Prepare Sidewalk web demo for Railway"
```

Then create a GitHub repo and push:

```sh
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

## Railway Deployment

Railway can deploy this directly from GitHub. `railway.json` already sets:

- `gunicorn` start command
- bind to Railway's `PORT`
- `/healthz` health check
- restart-on-failure policy

Keep this as a single app worker for now. The MQTT uplink listener runs in-process, so multiple gunicorn workers would create duplicate subscriptions and duplicate SSE events.

Deploy flow:

1. Push this folder to GitHub as its own repo.
2. In Railway, choose `New Project` -> `Deploy from GitHub repo`.
3. Select the repo.
4. Add the environment variables from `.env.example`.
5. Deploy.
6. Open the Railway-generated domain over `https://`.

Web Bluetooth requires a secure context, so Railway's HTTPS domain is suitable.

## Security Notes

Do not commit real AWS keys or login passwords into the repo.

This app already has an internal login page. For stronger public exposure controls, put a second access layer in front of Railway, for example Cloudflare Access or a similar identity proxy. The app login is still useful even with that in place.

## Firmware Build

The paired firmware expects:

- button trigger on `P1.04`
- LED feedback on `P2.00`
- BLE shell over Nordic UART Service

Build the XIAO variant with:

```sh
west build -p always -b xiao_nrf54l15/nrf54l15/cpuapp app \
  -d build/xiao-web-demo \
  -- \
  -DFILE_SUFFIX=release \
  -DOVERLAY_CONFIG='overlay-min-size.conf;overlay-prop-radio.conf;overlay-web-demo.conf' \
  -DDTC_OVERLAY_FILE='boards/xiao_nrf54l15_nrf54l15_cpuapp.overlay;overlay-web-demo.overlay'
```

The generated image is:

```text
build/xiao-web-demo/merged.hex
```
