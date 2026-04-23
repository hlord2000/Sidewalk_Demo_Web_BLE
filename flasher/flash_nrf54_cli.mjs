import fs from "node:fs/promises";
import process from "node:process";

import DAPjsModule from "dapjs";
import WebUSBModule from "webusb";

const DAPjs = DAPjsModule.default ?? DAPjsModule;
const { USB } = WebUSBModule;

const VENDOR_ID = 0x2886;
const PRODUCT_ID = 0x0066;
const SWD_CLOCK_HZ = 1_000_000;
const DAP_PROTOCOL_SWD = 1;

const DP_DPIDR = 0x0;
const AP_IDR = 0x0fc;

const CTRL_AP = 2 << 24;

const CTRL_AP_RESET = CTRL_AP | 0x000;
const CTRL_AP_ERASEALL = CTRL_AP | 0x004;
const CTRL_AP_ERASEALLSTATUS = CTRL_AP | 0x008;
const CTRL_AP_ERASEPROTECTSTATUS = CTRL_AP | 0x00c;
const CTRL_AP_IDR = CTRL_AP | 0x0fc;

const RRAMC_COMMITWRITEBUF = 0x5004b008;
const RRAMC_READY = 0x5004b400;
const RRAMC_CONFIG = 0x5004b500;

const AIRCR = 0xe000ed0c;
const AIRCR_VECTKEY = 0x05fa0000;
const AIRCR_SYSRESETREQ = 1 << 2;
const PROGRESS_LOG_STEP = 16 * 1024;
const RRAMC_WRITE_BUFFER_LINES = 1;
const RRAMC_WRITE_CHUNK_BYTES = RRAMC_WRITE_BUFFER_LINES * 16;
const RRAMC_WRITE_CONFIG = (RRAMC_WRITE_BUFFER_LINES << 8) | 0x1;

function parseArgs(argv) {
  const options = {
    firmware: "",
    serialNumber: "",
    eraseAll: false,
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--firmware" || arg === "-f") {
      options.firmware = argv[idx + 1] || "";
      idx += 1;
      continue;
    }
    if (arg === "--serial-number" || arg === "-s") {
      options.serialNumber = argv[idx + 1] || "";
      idx += 1;
      continue;
    }
    if (arg === "--erase-all") {
      options.eraseAll = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.firmware) {
    throw new Error("Missing --firmware <path>");
  }

  return options;
}

function hexByte(text, start) {
  return Number.parseInt(text.slice(start, start + 2), 16);
}

function parseIntelHex(text) {
  const segments = [];
  let upperLinear = 0;
  let upperSegment = 0;
  let eofSeen = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!line.startsWith(":")) {
      throw new Error(`Invalid Intel HEX record: ${line}`);
    }

    const bytes = [];
    for (let idx = 1; idx < line.length; idx += 2) {
      bytes.push(hexByte(line, idx));
    }

    const count = bytes[0];
    const addr = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    const data = bytes.slice(4, 4 + count);
    const checksum = bytes[4 + count];
    const sum = bytes.slice(0, 4 + count).reduce((acc, value) => (acc + value) & 0xff, 0);
    const expectedChecksum = ((~sum + 1) & 0xff);

    if (checksum !== expectedChecksum) {
      throw new Error(`Bad checksum in record: ${line}`);
    }

    if (type === 0x00) {
      const base =
        upperLinear !== 0 ? (upperLinear << 16) :
        upperSegment !== 0 ? (upperSegment << 4) :
        0;
      const absolute = base + addr;
      const payload = Uint8Array.from(data);
      const previous = segments.at(-1);

      if (previous && previous.address + previous.data.length === absolute) {
        const merged = new Uint8Array(previous.data.length + payload.length);
        merged.set(previous.data);
        merged.set(payload, previous.data.length);
        previous.data = merged;
      } else {
        segments.push({ address: absolute, data: payload });
      }
      continue;
    }

    if (type === 0x01) {
      eofSeen = true;
      break;
    }

    if (type === 0x02) {
      upperSegment = (data[0] << 8) | data[1];
      upperLinear = 0;
      continue;
    }

    if (type === 0x04) {
      upperLinear = (data[0] << 8) | data[1];
      upperSegment = 0;
      continue;
    }

    if (type === 0x03 || type === 0x05) {
      continue;
    }

    throw new Error(`Unsupported Intel HEX record type 0x${type.toString(16)}`);
  }

  if (!eofSeen) {
    throw new Error("Intel HEX EOF record missing");
  }

  return segments;
}

function bytesToWords(bytes) {
  const words = new Uint32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let idx = 0; idx < words.length; idx += 1) {
    words[idx] = view.getUint32(idx * 4, true);
  }

  return words;
}

function wordsToBytes(words, length) {
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);

  for (let idx = 0; idx < words.length; idx += 1) {
    view.setUint32(idx * 4, words[idx], true);
  }

  return bytes.subarray(0, length);
}

function wordToBytes(word) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, word >>> 0, true);
  return bytes;
}

function formatHex(value, width = 8) {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

function makeProgressLogger(label, totalBytes) {
  let completed = 0;
  let lastPrinted = 0;

  return (delta) => {
    completed += delta;
    if ((completed - lastPrinted) < PROGRESS_LOG_STEP && completed !== totalBytes) {
      return;
    }

    lastPrinted = completed;
    console.log(`  ${label} ${completed}/${totalBytes}`);
  };
}

async function waitFor(condition, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

async function waitRramReady(dap) {
  await waitFor(async () => (await dap.readMem32(RRAMC_READY)) === 1, 10_000);
}

async function writePartialWords(dap, address, data) {
  let offset = 0;

  while (offset < data.length) {
    const currentAddress = address + offset;
    const alignedAddress = currentAddress & ~0x3;
    const byteOffset = currentAddress & 0x3;
    const count = Math.min(4 - byteOffset, data.length - offset);
    const bytes = wordToBytes(await dap.readMem32(alignedAddress));

    bytes.set(data.subarray(offset, offset + count), byteOffset);

    const value = new DataView(bytes.buffer).getUint32(0, true);
    await dap.writeMem32(alignedAddress, value);
    offset += count;
  }
}

async function readPartialWords(dap, address, length) {
  const data = new Uint8Array(length);
  let offset = 0;

  while (offset < length) {
    const currentAddress = address + offset;
    const alignedAddress = currentAddress & ~0x3;
    const byteOffset = currentAddress & 0x3;
    const count = Math.min(4 - byteOffset, length - offset);
    const bytes = wordToBytes(await dap.readMem32(alignedAddress));

    data.set(bytes.subarray(byteOffset, byteOffset + count), offset);
    offset += count;
  }

  return data;
}

async function writeBytes(dap, address, data) {
  let offset = 0;

  if ((address & 0x3) !== 0) {
    const prefixBytes = Math.min(4 - (address & 0x3), data.length);
    await writePartialWords(dap, address, data.subarray(0, prefixBytes));
    offset += prefixBytes;
  }

  const wordBytes = (data.length - offset) & ~0x3;
  if (wordBytes > 0) {
    const words = bytesToWords(data.subarray(offset, offset + wordBytes));
    await dap.writeBlock(address + offset, words);
    offset += wordBytes;
  }

  while (offset < data.length) {
    const tailAddress = address + offset;
    const tail = data.subarray(offset);
    await writePartialWords(dap, tailAddress, tail);
    offset += tail.length;
  }
}

async function readBytes(dap, address, length) {
  const data = new Uint8Array(length);
  let offset = 0;

  if ((address & 0x3) !== 0) {
    const prefixBytes = Math.min(4 - (address & 0x3), length);
    data.set(await readPartialWords(dap, address, prefixBytes), 0);
    offset += prefixBytes;
  }

  const wordBytes = (length - offset) & ~0x3;
  if (wordBytes > 0) {
    const words = await dap.readBlock(address + offset, wordBytes / 4);
    data.set(wordsToBytes(words, wordBytes), offset);
    offset += wordBytes;
  }

  while (offset < length) {
    const tailAddress = address + offset;
    const tailLength = length - offset;
    data.set(await readPartialWords(dap, tailAddress, tailLength), offset);
    offset += tailLength;
  }

  return data;
}

async function writeRramChunks(dap, segment, progress) {
  const pageSize = RRAMC_WRITE_CHUNK_BYTES;
  const data = segment.data;

  for (let offset = 0; offset < data.length; offset += pageSize) {
    const chunk = data.subarray(offset, Math.min(offset + pageSize, data.length));
    const address = segment.address + offset;

    await writeBytes(dap, address, chunk);
    if (chunk.length !== pageSize) {
      await dap.writeMem32(RRAMC_COMMITWRITEBUF, 1);
    }

    progress(chunk.length, address);
  }

  await waitRramReady(dap);
}

async function verifySegment(dap, segment, progress) {
  const pageSize = RRAMC_WRITE_CHUNK_BYTES;
  const data = segment.data;

  for (let offset = 0; offset < data.length; offset += pageSize) {
    const chunk = data.subarray(offset, Math.min(offset + pageSize, data.length));
    const address = segment.address + offset;
    const actual = await readBytes(dap, address, chunk.length);

    for (let idx = 0; idx < chunk.length; idx += 1) {
      if (actual[idx] !== chunk[idx]) {
        throw new Error(
          `Verify failed at ${formatHex(address + idx)}: expected ${formatHex(chunk[idx], 2)}, got ${formatHex(actual[idx], 2)}`
        );
      }
    }

    progress(chunk.length, address);
  }
}

async function maybeEraseAll(dap, eraseAll) {
  if (!eraseAll) {
    return;
  }

  const ctrlApIdr = await dap.readAP(CTRL_AP_IDR);
  const eraseProtectStatus = await dap.readAP(CTRL_AP_ERASEPROTECTSTATUS);
  console.log(`CTRL-AP IDR: ${formatHex(ctrlApIdr)}`);
  console.log(`CTRL-AP ERASEPROTECTSTATUS: ${formatHex(eraseProtectStatus)}`);

  console.log("Issuing CTRL-AP ERASEALL");
  await dap.writeAP(CTRL_AP_ERASEALL, 1);

  await waitFor(async () => {
    const status = await dap.readAP(CTRL_AP_ERASEALLSTATUS);
    if (status === 2) {
      return false;
    }
    if (status === 1) {
      return true;
    }
    throw new Error(`ERASEALLSTATUS returned ${formatHex(status)}`);
  }, 30_000);

  await dap.writeAP(CTRL_AP_RESET, 2);
  await dap.writeAP(CTRL_AP_RESET, 0);
  console.log("CTRL-AP ERASEALL complete");
}

async function requestDevice(serialNumber) {
  const usb = new USB({
    devicesFound: async (devices) => {
      const matches = devices.filter((device) => {
        const vendorId = device.vendorId ?? device.deviceDescriptor?.idVendor;
        const productId = device.productId ?? device.deviceDescriptor?.idProduct;
        const serial = device.serialNumber ?? "";
        if (vendorId !== VENDOR_ID || productId !== PRODUCT_ID) {
          return false;
        }
        if (serialNumber && serial !== serialNumber) {
          return false;
        }
        return true;
      });

      if (matches.length === 0) {
        throw new Error("No matching XIAO nRF54 CMSIS-DAP device found");
      }

      return matches[0];
    },
  });

  return usb.requestDevice({
    filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const hexText = await fs.readFile(options.firmware, "utf8");
  const segments = parseIntelHex(hexText);
  const totalBytes = segments.reduce((sum, segment) => sum + segment.data.length, 0);

  console.log(`Firmware: ${options.firmware}`);
  console.log(`Segments: ${segments.length}`);
  console.log(`Total bytes: ${totalBytes}`);

  const device = await requestDevice(options.serialNumber);
  console.log(`Selected device: ${device.productName || "Unknown"} ${device.serialNumber || ""}`.trim());

  const transport = new DAPjs.WebUSB(device);
  const dap = new DAPjs.CortexM(transport, DAP_PROTOCOL_SWD, SWD_CLOCK_HZ);

  await dap.connect();
  try {
    const dpidr = await dap.readDP(DP_DPIDR);
    console.log(`DPIDR: ${formatHex(dpidr)}`);

    await maybeEraseAll(dap, options.eraseAll);

    console.log("Halting Cortex-M33");
    await dap.halt();

    console.log("Enabling RRAM writes");
    await dap.writeMem32(RRAMC_CONFIG, RRAMC_WRITE_CONFIG);
    await waitRramReady(dap);

    const reportProgram = makeProgressLogger("program", totalBytes);
    for (const segment of segments) {
      console.log(`Programming ${segment.data.length} bytes at ${formatHex(segment.address)}`);
      await writeRramChunks(dap, segment, reportProgram);
    }

    console.log("Restoring RRAM to read-only");
    await dap.writeMem32(RRAMC_CONFIG, 0x0);

    const reportVerify = makeProgressLogger("verify", totalBytes);
    for (const segment of segments) {
      console.log(`Verifying ${segment.data.length} bytes at ${formatHex(segment.address)}`);
      await verifySegment(dap, segment, reportVerify);
    }

    console.log("Requesting SYSRESETREQ");
    await dap.writeMem32(AIRCR, AIRCR_VECTKEY | AIRCR_SYSRESETREQ);
    console.log("Flash and verify completed successfully");
  } finally {
    await dap.disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
