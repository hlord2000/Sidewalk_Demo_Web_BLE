# npm DAP.js WebUSB App

Standalone Vite app that talks to a CMSIS-DAP probe over WebUSB using the published `dapjs` npm package.

Current scope:

- request or reuse an authorized WebUSB CMSIS-DAP probe
- parse a local Intel HEX image
- recover an `nRF54L15` through Nordic CTRL-AP
- flash the image with a custom RAM-resident `nRF54L15` RRAM stub
- optionally verify the programmed image with readback

## Notes

- The flash stub source lives in `tools/rram_flash_stub.S`.
- The browser app streams image blocks into target RAM, then calls the stub to copy those blocks into RRAM. This avoids slow per-word SWD writes directly into flash.

## Run

```sh
npm install
npm run dev -- --host 127.0.0.1 --port 4173
```

## Build

```sh
npm run build
```

Use a Chromium browser with WebUSB support and open the Vite URL over `127.0.0.1` or `localhost`.
