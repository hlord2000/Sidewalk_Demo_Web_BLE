The DK UART shell advertises as `Sidewalk DK WebShell`; its GATT Device Name
also uses that exact name so OS-discovered names agree. The separate Amazon
Sidewalk radio advertiser is not a command shell. All website chooser paths
now require the Nordic UART service; device names are only display hints.

Firmware source: `ncs-sidewalk-demo-application` commit `adcbd4c`.
Runtime version: `0.0.1+f28fd1`. The current downloadable
`firmware/SidewalkDevkit-Memfault.hex` contains both application slots.

Legacy advertising carries flags plus the complete name (25 bytes total).
The scan response carries the 128-bit UART UUID plus the unchanged 8-byte
Sidewalk fingerprint in Nordic manufacturer data (31 bytes total). Blank
boards omit manufacturer data but retain the same name and UART service.
Compile-time assertions enforce packet bounds.

Validation: both firmware slots built; 1,343,656 image bytes matched target
readback; the manufacturing credential page was unchanged. On DK device 14,
active BLE scanning observed the full name, UART UUID, and fingerprint
`EAD1E9D6571C2B03`. A GATT session verified the matching Device Name, provisioning, and runtime version.
The first discovery attempt disconnected; a subsequent attempt passed. This
advertiser correction does not establish the cause of the intermittent drop.
Native Chrome chooser behavior still requires confirmation on the user's
browser. Website tests: 120 Python tests and 17 Node browser-logic tests passed.
