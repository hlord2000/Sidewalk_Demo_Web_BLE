# Automatic provisioning validation — 2026-09-10

Site: https://nordicsidewalk.xyz/

## Real hardware run

- Debugger USB serial: `CCC9D6D965C01090`, target UART interface 02.
- Target silicon ID: `eda90c49f2dc4c87`.
- Firmware: `sidewalk-demo`, `0.0.1+dffc81`, hardware `sidewalk_devkit_nrf54l15`.
- Initial target status: unprovisioned, no manufacturing serial.
- Automatically created local device 13, `Sidewalk Devkit a18a78a1`.
- Amazon WirelessDeviceId: `8c71f4a9-4887-4935-b9af-8719c33db010`.
- Amazon device profile: `c41945ef-7b72-4de4-8663-c3a898dd0447`, taken from the existing devkit profile and configured as the site's automatic-creation default.
- All 35 credential values acknowledged by the real target; finalize succeeded.
- Target rebooted and `prov status` returned provisioned with SMSN `2428B5D6D6D16FA7905810CCEC8865D278DBFC03CD7037B4443AC6460C4C884D`.
- Backend recorded verified status at `2026-09-10T15:53:01+00:00`.
- Fresh Amazon read returned `PROVISIONED`.
- Fresh Memfault health read returned `registered: true`, matching SMSN, nickname, and hardware version.
- Firmware `mflt info` independently returned the same SMSN after reboot.
- Running automatic detection again returned “This device is already provisioned”; no new cloud request or credential rewrite.

The logged-in Backplane browser ran the deployed UI and backend. Its native
USB chooser immediately cancelled, and it does not expose Web Bluetooth.
For the hardware run only, `navigator.serial.requestPort` was adapted to a
short-lived, token-protected localhost WebSocket bridge to the real target UART.
The bridge accepted only the site's Origin, bound only to loopback, and had no
credential logging. Device replies and cloud APIs were real, not mocked.
Native Web Serial selection and physical Web Bluetooth transport are therefore
not verified by this run. This run verifies provisioning, not an over-the-air
Sidewalk gateway registration/uplink test.

## Automated checks

- 120 Python tests passed, including allowed/denied customer permissions,
  cross-account isolation, empty-account onboarding, identical AWS retry
  tokens, artifact-fetch failure recovery, and Memfault failure recovery.
- Six JavaScript flow tests passed: successful setup with synchronous replies,
  denied account, existing identity, identity appearing before erase, and
  rejected credential abort, and first-device dashboard activation.
- Mobile layout checked at 390 CSS pixels. Wrapped the long device serial to
  remove horizontal overflow on the verification screen.
- JavaScript syntax checks and `git diff --check` passed.
