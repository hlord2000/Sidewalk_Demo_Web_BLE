# Sidewalk Web Demo

Flask web app for a Sidewalk device demo:

- login-gated dashboard
- Sidewalk cloud downlink sends via AWS IoT Wireless
- live uplink monitoring via AWS IoT MQTT over SSE
- Web Bluetooth shell over Nordic UART Service
- browser controls for Sidewalk Location scans and reports
- admin message log: every Sidewalk message and every raw BLE shell line, with
  the device it came from
- Memfault gateway: forwards Memfault SDK chunks carried over Sidewalk uplinks
  to Memfault, and reads device health back for the dashboard
- BLE NUS provisioning: writes Sidewalk manufacturing credentials to a blank
  device over the existing Nordic UART Service link

## Repo Layout

- `app.py`: Flask entry point
- `config.py`: environment-variable based runtime config
- `iot.py`: AWS IoT Wireless downlink + MQTT uplink bridge, and Memfault chunk
  detection on the raw uplink payload
- `storage.py`: SQLite store (users, devices, sensor history, message log,
  Memfault chunk queue, provisioning outcomes)
- `provisioning.py`: builds the Sidewalk manufacturing credentials from AWS or
  a certificate.json export, and the BLE NUS command script that writes them
- `memfault.py`: chunk-forwarding queue worker and the Memfault read API client
- `templates/`, `static/`: UI
- `railway.json`: Railway start and health-check config
- `.env.example`: required environment variables

## Local Run

```sh
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
- `AWS_IOT_LOCATION_TOPIC`
- `SIDEWALK_WIRELESS_DEVICE_ID`

Usually keep these too:

- `AWS_REGION=us-east-1`
- `SESSION_COOKIE_SECURE=true`
- `MQTT_CLIENT_ID=sidewalk-web-demo`
- `SIDEWALK_LOCATION_DESTINATION_NAME=<AWS location destination>`

The NUS UUIDs already default to Nordic UART Service and usually do not need changes.

Memfault and BLE NUS provisioning are both optional and default to off or to
conservative defaults:

- `SIDEWALK_PROVISIONING_MAX_FRAGMENT_BYTES` (default `64`): raw bytes per
  `prov set` fragment sent over the NUS shell, before base64 expansion. The
  largest single credential value is 64 bytes, so the default ships every
  value in one command.
- `MEMFAULT_ENABLED` (default `false`): turns on chunk forwarding. Leave unset
  to keep the feature off entirely.
- `MEMFAULT_PROJECT_KEY`: the device-facing project key used to POST chunks to
  Memfault's chunks API. Required for forwarding.
- `MEMFAULT_ORG_SLUG`, `MEMFAULT_PROJECT_SLUG`, `MEMFAULT_ORG_AUTH_TOKEN`:
  needed for the read side (device health, connectivity test). Health reports
  "not configured" when any of these are missing.
- `MEMFAULT_CHUNKS_BASE_URL` (default `https://chunks.memfault.com`),
  `MEMFAULT_API_BASE_URL` (default `https://api.memfault.com`).
- `MEMFAULT_DEVICE_SERIAL_SOURCE` (default `smsn`): which device identifier to
  send chunks under. `smsn` uses the Sidewalk manufacturing serial when known,
  falling back to the AWS wireless device id. `wireless_device_id` always uses
  that id.
- `MEMFAULT_HTTP_TIMEOUT_SECS` (default `10`), `MEMFAULT_CHUNK_MAX_ATTEMPTS`
  (default `8`), `MEMFAULT_CHUNK_MAX_BACKOFF_SECS` (default `300`),
  `MEMFAULT_WORKER_POLL_SECS` (default `5`): forwarding worker tuning.

## Git Repo

This folder can still be deployed as its own repo root if you want to split the
web service out later.

```sh
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

Keep this as a single app worker for now. The MQTT uplink listener runs in-process,
so multiple gunicorn workers would create duplicate subscriptions and split SSE
events between processes. The configured threaded worker supports many concurrent
SSE viewers, reconnects resume from the last event cursor instead of replaying the
whole backlog, and SQLite uses WAL mode with a busy timeout for concurrent reads
and writes.

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

## Memfault Gateway

The nRF54L15 firmware has no IP stack, so it emits Memfault SDK packetizer
output as Sidewalk uplinks and this backend forwards it. The wire format on
the raw uplink payload is one tag byte (`0xC0`), one wrapping sequence byte,
then the raw Memfault chunk. Detection happens before any of the existing
printable-ASCII/hex decoding heuristics run, so a binary chunk cannot get
mangled by them.

A chunk is written to the `memfault_chunks` table the moment it arrives on
the MQTT listener thread, then a separate daemon thread drains that table and
POSTs each chunk to `https://chunks.memfault.com/api/v0/chunks/<device_serial>`
with a `Memfault-Project-Key` header. Failed attempts back off exponentially
and stop retrying after `MEMFAULT_CHUNK_MAX_ATTEMPTS`. Because the queue lives
in SQLite, a chunk survives a process restart.

Routes:

- `GET /api/devices/<id>/memfault-health`: session-authed, health for a device
  the caller owns. Reports `{"configured": false, ...}` when the read API
  environment variables are unset.
- `GET /api/admin/memfault/chunks`: admin-only, recent chunk-forwarding status
  for debugging the pipeline.
- `POST /api/admin/memfault/test-connectivity`: admin-only, probes the
  Memfault org API and reports the actual HTTP status.

The read API (device health, reboot counts) has not been verified against a
live Memfault account. Response shapes are normalized defensively and logged
at debug level so field mapping can be corrected once real credentials exist.

## BLE NUS Provisioning

A blank device has Sidewalk credentials in AWS (or in a `certificate.json`
exported from the AWS console) but nothing written to its `mfg_storage` flash
partition yet. The primary path writes those credentials over the existing
Nordic UART Service link; a device with a broken BLE stack can still be
flashed with the existing `mfg.bin`/`mfg.hex` admin downloads over `nrfutil`.

Firmware writes each credential with `sid_pal_mfg_store_write(value_id, ...)`,
so the backend exposes credentials as named values instead of one binary
blob. The numeric ids match `sid_pal_mfg_store_value_t` in the Sidewalk SDK
header (`sid_pal_mfg_store_ifc.h`); `provisioning.MFG_STORE_VALUES` is the
single place that lists them alongside their expected byte length.

Routes:

- `GET /api/devices/<id>/provisioning-values`: session-authed, gated the same
  way as the existing firmware-provisioning download (admins, or customers
  marked `can_provision`). Returns each credential as
  `{"<value_id>": {"name", "length", "base64"}}`.
- `GET /api/devices/<id>/provisioning-script`: same gate. Returns the ordered
  NUS shell commands to write (`prov erase`, `prov set <id> <len> [<frag>]
  <base64>` per value, `prov finalize`, `prov reboot`), plus the terminal and
  progress event shapes to watch for.
- `POST /admin/devices/<id>/certificate-json`: admin-only, multipart upload of
  a `certificate_json` file exported from the AWS console. Validates presence
  and byte length of every field, never logs or echoes the private key
  fields, and stores the result so the two routes above work immediately
  afterward.
- `POST /api/devices/<id>/provisioning-status`: session-authed, same
  provisioning gate. Records one outcome (`attempted`, `succeeded`,
  `verified`, or `failed`) with a reason, a timestamp, and the acting user.
- `GET /admin/devices/<id>/provisioning-events`: admin-only, the full outcome
  history for one device.

The firmware also reports progress and outcome on the NUS shell itself, which
reaches this backend through the existing `POST /api/ble-log` route:

- `EVT:{"t":"provwr","id":<value_id>,"ok":<bool>}` per value, visible in the
  message log and live stream.
- `EVT:{"t":"provdone","ok":<bool>,"err":"..."}` at the end of a write,
  recorded as `succeeded` or `failed`.
- `EVT:{"t":"prov","provisioned":<bool>,"smsn":"...","mfg_ver":<uint>}` at
  boot and on BLE connect. A `true` value is recorded as `verified`; `false`
  just means the device is blank and is not treated as a failure.

The exact `prov` command grammar (argument order, fragmentation) is pending
confirmation from the firmware side. All of it is assembled in one place,
`provisioning.build_provisioning_commands`, so a wire-format change is a
single edit.

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
