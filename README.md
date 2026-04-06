# Sidewalk Web Demo

NOTE: use [https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055](Bluefy) on iOS to properly access

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
cd /opt/ncs/sdks/ncs-sdk-sidewalk/sdk-sidewalk/tools/web_demo
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

This folder is intended to be its own deployable repo root.

```sh
cd /opt/ncs/sdks/ncs-sdk-sidewalk/sdk-sidewalk/tools/web_demo
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
