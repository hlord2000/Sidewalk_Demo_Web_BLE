const config = window.DEMO_CONFIG;

const downlinkForm = document.getElementById("downlink-form");
const payloadInput = document.getElementById("payload");
const ackedInput = document.getElementById("acked");
const messageTypeInput = document.getElementById("message-type");
const seqInput = document.getElementById("seq");
const downlinkStatus = document.getElementById("downlink-status");
const eventLog = document.getElementById("event-log");
const deviceSelector = document.getElementById("device-selector");
const selectedDeviceChip = document.getElementById("selected-device-chip");
const selectedTopicChip = document.getElementById("selected-topic-chip");
const bleNamePrefixLabel = document.getElementById("ble-name-prefix");

const bleStatus = document.getElementById("ble-status");
const bleTerminal = document.getElementById("ble-terminal");
const bleCommandForm = document.getElementById("ble-command-form");
const bleCommandInput = document.getElementById("ble-command");
const bleConnectButton = document.getElementById("ble-connect");
const bleDisconnectButton = document.getElementById("ble-disconnect");
const eventFeedStatus = document.getElementById("event-feed-status");
const flashFileInput = document.getElementById("flash-file");
const flashPresetSelect = document.getElementById("flash-preset");
const flashConnectButton = document.getElementById("flash-connect");
const flashDisconnectButton = document.getElementById("flash-disconnect");
const flashButton = document.getElementById("flash-button");
const flashEraseButton = document.getElementById("flash-erase");
const flashRecoverButton = document.getElementById("flash-recover");
const flashClearLogButton = document.getElementById("flash-clear-log");
const flashStatus = document.getElementById("flash-status");
const flashLog = document.getElementById("flash-log");
const flashImageChip = document.getElementById("flash-image-chip");
const flashProbeChip = document.getElementById("flash-probe-chip");
const flashSupportChip = document.getElementById("flash-support-chip");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");
const devices = config.devices || [];
const deviceMap = new Map(devices.map((device) => [String(device.id), device]));
const deviceByWirelessId = new Map(devices.map((device) => [device.wirelessDeviceId, device]));
const firmwareImages = config.firmwareImages || [];
const firmwareImageMap = new Map(firmwareImages.map((image) => [image.id, image]));

const ANSI_COLORS = [
  "#0f172a",
  "#7f1d1d",
  "#14532d",
  "#854d0e",
  "#1e3a8a",
  "#6b21a8",
  "#0f766e",
  "#334155",
];

const ANSI_BRIGHT_COLORS = [
  "#1e293b",
  "#ef4444",
  "#22c55e",
  "#f59e0b",
  "#3b82f6",
  "#a855f7",
  "#14b8a6",
  "#cbd5e1",
];

const FLASH_VENDOR_ID = 0x2886;
const FLASH_PRODUCT_ID = 0x0066;
const FLASH_SWD_CLOCK_HZ = 1_000_000;
const FLASH_DAP_PROTOCOL_SWD = 1;
const FLASH_DP_DPIDR = 0x0;
const FLASH_CTRL_AP = 2 << 24;
const FLASH_CTRL_AP_RESET = FLASH_CTRL_AP | 0x000;
const FLASH_CTRL_AP_ERASEALL = FLASH_CTRL_AP | 0x004;
const FLASH_CTRL_AP_ERASEALLSTATUS = FLASH_CTRL_AP | 0x008;
const FLASH_CTRL_AP_ERASEPROTECTSTATUS = FLASH_CTRL_AP | 0x00c;
const FLASH_CTRL_AP_IDR = FLASH_CTRL_AP | 0x0fc;
const FLASH_RRAMC_COMMITWRITEBUF = 0x5004b008;
const FLASH_RRAMC_READY = 0x5004b400;
const FLASH_RRAMC_CONFIG = 0x5004b500;
const FLASH_AIRCR = 0xe000ed0c;
const FLASH_AIRCR_VECTKEY = 0x05fa0000;
const FLASH_AIRCR_SYSRESETREQ = 1 << 2;
const FLASH_PROGRESS_STEP = 16 * 1024;
const FLASH_WRITE_BUFFER_LINES = 1;
const FLASH_WRITE_CHUNK_BYTES = FLASH_WRITE_BUFFER_LINES * 16;
const FLASH_WRITE_CONFIG = (FLASH_WRITE_BUFFER_LINES << 8) | 0x1;
const FLASH_MAX_LOG_LINES = 240;

function cloneStyle(style) {
  return {
    fg: style.fg,
    bg: style.bg,
    bold: style.bold,
    underline: style.underline,
    inverse: style.inverse,
  };
}

function defaultTerminalStyle() {
  return {
    fg: null,
    bg: null,
    bold: false,
    underline: false,
    inverse: false,
  };
}

class TerminalRenderer {
  constructor(element) {
    this.element = element;
    this.rows = [[]];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.savedCursor = null;
    this.style = defaultTerminalStyle();
    this.state = "normal";
    this.csiBuffer = "";
    this.cursorVisible = true;
    this.maxRows = 240;
    this.renderQueued = false;
  }

  feed(text) {
    for (let idx = 0; idx < text.length; idx++) {
      this._consumeChar(text[idx]);
    }
    this._scheduleRender();
  }

  _consumeChar(ch) {
    if (this.state === "normal") {
      if (ch === "\u001b") {
        this.state = "escape";
        return;
      }

      if (ch === "\r") {
        this.cursorCol = 0;
        return;
      }

      if (ch === "\n") {
        this.cursorRow += 1;
        this.cursorCol = 0;
        this._ensureRow(this.cursorRow);
        this._trimScrollback();
        return;
      }

      if (ch === "\b") {
        this.cursorCol = Math.max(0, this.cursorCol - 1);
        return;
      }

      if (ch === "\t") {
        const nextStop = (Math.floor(this.cursorCol / 8) + 1) * 8;
        while (this.cursorCol < nextStop) {
          this._writeChar(" ");
        }
        return;
      }

      if (ch < " ") {
        return;
      }

      this._writeChar(ch);
      return;
    }

    if (this.state === "escape") {
      if (ch === "[") {
        this.state = "csi";
        this.csiBuffer = "";
        return;
      }

      if (ch === "7") {
        this.savedCursor = {
          row: this.cursorRow,
          col: this.cursorCol,
          style: cloneStyle(this.style),
        };
      } else if (ch === "8" && this.savedCursor) {
        this.cursorRow = this.savedCursor.row;
        this.cursorCol = this.savedCursor.col;
        this.style = cloneStyle(this.savedCursor.style);
      } else if (ch === "c") {
        this.rows = [[]];
        this.cursorRow = 0;
        this.cursorCol = 0;
        this.style = defaultTerminalStyle();
      }

      this.state = "normal";
      return;
    }

    if (this.state === "csi") {
      this.csiBuffer += ch;
      if (!/[@-~]$/.test(ch)) {
        return;
      }

      this._applyCsi(this.csiBuffer);
      this.state = "normal";
      this.csiBuffer = "";
    }
  }

  _ensureRow(row) {
    while (this.rows.length <= row) {
      this.rows.push([]);
    }
  }

  _ensureCell(row, col) {
    this._ensureRow(row);
    const line = this.rows[row];
    while (line.length <= col) {
      line.push({ char: " ", style: defaultTerminalStyle() });
    }
    return line;
  }

  _writeChar(ch) {
    const line = this._ensureCell(this.cursorRow, this.cursorCol);
    line[this.cursorCol] = {
      char: ch,
      style: cloneStyle(this.style),
    };
    this.cursorCol += 1;
  }

  _trimScrollback() {
    if (this.rows.length <= this.maxRows) {
      return;
    }

    const excess = this.rows.length - this.maxRows;
    this.rows.splice(0, excess);
    this.cursorRow = Math.max(0, this.cursorRow - excess);
    if (this.savedCursor) {
      this.savedCursor.row = Math.max(0, this.savedCursor.row - excess);
    }
  }

  _clearToEndOfLine() {
    this._ensureRow(this.cursorRow);
    this.rows[this.cursorRow].length = this.cursorCol;
  }

  _clearScreenFromCursor() {
    this._ensureRow(this.cursorRow);
    this.rows[this.cursorRow].length = this.cursorCol;
    this.rows.splice(this.cursorRow + 1);
  }

  _clearScreenToCursor() {
    for (let row = 0; row < this.cursorRow; row++) {
      this.rows[row] = [];
    }
    this._ensureRow(this.cursorRow);
    this.rows[this.cursorRow].splice(0, this.cursorCol);
  }

  _applySgr(params) {
    const values = params.length ? params : [0];
    for (const value of values) {
      if (value === 0) {
        this.style = defaultTerminalStyle();
      } else if (value === 1) {
        this.style.bold = true;
      } else if (value === 4) {
        this.style.underline = true;
      } else if (value === 7) {
        this.style.inverse = true;
      } else if (value === 22) {
        this.style.bold = false;
      } else if (value === 24) {
        this.style.underline = false;
      } else if (value === 27) {
        this.style.inverse = false;
      } else if (value >= 30 && value <= 37) {
        this.style.fg = ANSI_COLORS[value - 30];
      } else if (value >= 90 && value <= 97) {
        this.style.fg = ANSI_BRIGHT_COLORS[value - 90];
      } else if (value === 39) {
        this.style.fg = null;
      } else if (value >= 40 && value <= 47) {
        this.style.bg = ANSI_COLORS[value - 40];
      } else if (value >= 100 && value <= 107) {
        this.style.bg = ANSI_BRIGHT_COLORS[value - 100];
      } else if (value === 49) {
        this.style.bg = null;
      }
    }
  }

  _applyCsi(buffer) {
    let raw = buffer;
    let privateMode = false;
    if (raw.startsWith("?")) {
      privateMode = true;
      raw = raw.slice(1);
    }

    const final = raw.slice(-1);
    const body = raw.slice(0, -1);
    const params = body
      ? body.split(";").map((value) => {
          if (value === "") {
            return 0;
          }
          const parsed = Number.parseInt(value, 10);
          return Number.isNaN(parsed) ? 0 : parsed;
        })
      : [];

    switch (final) {
      case "A":
        this.cursorRow = Math.max(0, this.cursorRow - (params[0] || 1));
        break;
      case "B":
        this.cursorRow += params[0] || 1;
        this._ensureRow(this.cursorRow);
        break;
      case "C":
        this.cursorCol = Math.max(0, this.cursorCol + (params[0] || 1));
        break;
      case "D":
        this.cursorCol = Math.max(0, this.cursorCol - (params[0] || 1));
        break;
      case "H":
      case "f": {
        const row = Math.max(1, params[0] || 1) - 1;
        const col = Math.max(1, params[1] || 1) - 1;
        this.cursorRow = row;
        this.cursorCol = col;
        this._ensureRow(this.cursorRow);
        break;
      }
      case "J": {
        const mode = params[0] || 0;
        if (mode === 0) {
          this._clearScreenFromCursor();
        } else if (mode === 1) {
          this._clearScreenToCursor();
        } else if (mode === 2) {
          this.rows = [[]];
          this.cursorRow = 0;
          this.cursorCol = 0;
        }
        break;
      }
      case "K":
        this._clearToEndOfLine();
        break;
      case "m":
        this._applySgr(params);
        break;
      case "s":
        this.savedCursor = {
          row: this.cursorRow,
          col: this.cursorCol,
          style: cloneStyle(this.style),
        };
        break;
      case "u":
        if (this.savedCursor) {
          this.cursorRow = this.savedCursor.row;
          this.cursorCol = this.savedCursor.col;
          this.style = cloneStyle(this.savedCursor.style);
        }
        break;
      case "h":
        if (privateMode && params[0] === 25) {
          this.cursorVisible = true;
        }
        break;
      case "l":
        if (privateMode && params[0] === 25) {
          this.cursorVisible = false;
        }
        break;
      case "X": {
        const count = params[0] || 1;
        this._ensureRow(this.cursorRow);
        const line = this.rows[this.cursorRow];
        for (let idx = 0; idx < count; idx++) {
          if (this.cursorCol + idx < line.length) {
            line[this.cursorCol + idx] = { char: " ", style: defaultTerminalStyle() };
          }
        }
        break;
      }
      default:
        break;
    }
  }

  _styleToInline(style) {
    const resolved = this._resolveStyle(style);
    const css = [];
    if (resolved.fg) {
      css.push(`color: ${resolved.fg}`);
    }
    if (resolved.bg) {
      css.push(`background-color: ${resolved.bg}`);
    }
    if (resolved.bold) {
      css.push("font-weight: 600");
    }
    if (resolved.underline) {
      css.push("text-decoration: underline");
    }
    return css.join("; ");
  }

  _resolveStyle(style) {
    const resolved = cloneStyle(style);
    if (resolved.inverse) {
      const fg = resolved.fg;
      resolved.fg = resolved.bg;
      resolved.bg = fg;
    }
    return resolved;
  }

  _scheduleRender() {
    if (this.renderQueued) {
      return;
    }
    this.renderQueued = true;
    window.requestAnimationFrame(() => {
      this.renderQueued = false;
      this._render();
    });
  }

  _render() {
    const fragment = document.createDocumentFragment();
    const lastRowIndex = this.rows.length - 1;

    for (let rowIndex = 0; rowIndex < this.rows.length; rowIndex++) {
      const line = this.rows[rowIndex];
      const lineEl = document.createElement("div");
      lineEl.className = "terminal-line";

      if (line.length === 0) {
        lineEl.appendChild(document.createTextNode("\u00A0"));
      } else {
        for (let col = 0; col < line.length; col++) {
          const cell = line[col];
          const span = document.createElement("span");
          span.style.cssText = this._styleToInline(cell.style);
          if (this.cursorVisible && rowIndex === this.cursorRow && col === this.cursorCol) {
            span.classList.add("terminal-cursor");
          }
          span.textContent = cell.char === " " ? "\u00A0" : cell.char;
          lineEl.appendChild(span);
        }
      }

      if (this.cursorVisible && rowIndex === this.cursorRow && this.cursorCol >= line.length) {
        const cursor = document.createElement("span");
        cursor.className = "terminal-cursor";
        cursor.textContent = "\u00A0";
        lineEl.appendChild(cursor);
      }

      fragment.appendChild(lineEl);
      if (rowIndex !== lastRowIndex) {
        const newline = document.createElement("div");
        newline.className = "terminal-gap";
        fragment.appendChild(newline);
      }
    }

    this.element.replaceChildren(fragment);
    this.element.scrollTop = this.element.scrollHeight;
  }
}

let bleDevice = null;
let bleServer = null;
let bleRxCharacteristic = null;
let bleTxCharacteristic = null;
let eventSource = null;
let eventReconnectTimer = null;
let eventReconnectDelay = 1000;
const bleTerminalRenderer = new TerminalRenderer(bleTerminal);
let flashDevice = null;
let flashDap = null;
let flashBusy = false;
let flashLogLines = [];
let flashPresetFile = null;

function flashCurrentFile() {
  if (flashFileInput && flashFileInput.files && flashFileInput.files[0]) {
    return flashFileInput.files[0];
  }
  return flashPresetFile;
}

function flashSupportsWebUsb() {
  return window.isSecureContext && !!navigator.usb;
}

function flashFormatHex(value, width = 8) {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

function flashLogMessage(message) {
  if (!flashLog) {
    return;
  }

  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  flashLogLines.push(`[${stamp}] ${message}`);
  if (flashLogLines.length > FLASH_MAX_LOG_LINES) {
    flashLogLines = flashLogLines.slice(-FLASH_MAX_LOG_LINES);
  }

  flashLog.textContent = flashLogLines.join("\n");
  flashLog.scrollTop = flashLog.scrollHeight;
}

function setFlashStatus(text) {
  if (flashStatus) {
    flashStatus.textContent = text;
  }
}

function flashMatchesDevice(device) {
  return device.vendorId === FLASH_VENDOR_ID && device.productId === FLASH_PRODUCT_ID;
}

function flashSupportSummary() {
  if (!window.isSecureContext) {
    return "HTTPS or localhost required";
  }
  if (!navigator.usb) {
    return "WebUSB unsupported";
  }
  if (!window.DAPjs) {
    return "DAP runtime unavailable";
  }
  return "WebUSB ready";
}

function flashCurrentImageSummary() {
  const file = flashCurrentFile();
  if (!file) {
    return "No firmware selected";
  }

  if (flashPresetFile && file === flashPresetFile) {
    return `Built-in image: ${file.name}`;
  }

  return `Custom image: ${file.name}`;
}

function updateFlashUi() {
  const file = flashCurrentFile();
  const supported = flashSupportsWebUsb() && !!window.DAPjs;

  if (flashSupportChip) {
    flashSupportChip.textContent = flashSupportSummary();
  }

  if (flashProbeChip) {
    flashProbeChip.textContent = flashDevice
      ? `Probe: ${(flashDevice.productName || "CMSIS-DAP")} ${(flashDevice.serialNumber || "")}`.trim()
      : "No probe selected";
  }

  if (flashImageChip) {
    flashImageChip.textContent = flashCurrentImageSummary();
  }

  if (flashFileInput) {
    flashFileInput.disabled = flashBusy;
  }

  if (flashPresetSelect) {
    flashPresetSelect.disabled = flashBusy || firmwareImages.length === 0;
  }

  if (flashConnectButton) {
    flashConnectButton.disabled = flashBusy || !supported;
  }

  if (flashDisconnectButton) {
    flashDisconnectButton.disabled = flashBusy || (!flashDevice && !flashDap);
  }

  if (flashButton) {
    flashButton.disabled = flashBusy || !supported || !file;
  }

  if (flashEraseButton) {
    flashEraseButton.disabled = flashBusy || !supported;
  }

  if (flashRecoverButton) {
    flashRecoverButton.disabled = flashBusy || !supported;
  }
}

function flashHexByte(text, start) {
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
      bytes.push(flashHexByte(line, idx));
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
      const previous = segments.length > 0 ? segments[segments.length - 1] : null;

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

    throw new Error(`Unsupported Intel HEX record type ${flashFormatHex(type, 2)}`);
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

async function waitForCondition(condition, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

async function waitFlashReady(dap) {
  await waitForCondition(async () => (await dap.readMem32(FLASH_RRAMC_READY)) === 1, 10_000);
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

async function writeFlashBytes(dap, address, data) {
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

async function readFlashBytes(dap, address, length) {
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
  const chunkSize = FLASH_WRITE_CHUNK_BYTES;
  const data = segment.data;

  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    const address = segment.address + offset;

    await writeFlashBytes(dap, address, chunk);
    if (chunk.length !== chunkSize) {
      await dap.writeMem32(FLASH_RRAMC_COMMITWRITEBUF, 1);
    }

    progress(chunk.length);
  }

  await waitFlashReady(dap);
}

async function verifyFlashSegment(dap, segment, progress) {
  const chunkSize = FLASH_WRITE_CHUNK_BYTES;
  const data = segment.data;

  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    const address = segment.address + offset;
    const actual = await readFlashBytes(dap, address, chunk.length);

    for (let idx = 0; idx < chunk.length; idx += 1) {
      if (actual[idx] !== chunk[idx]) {
        throw new Error(
          `Verify failed at ${flashFormatHex(address + idx)}: expected ${flashFormatHex(chunk[idx], 2)}, got ${flashFormatHex(actual[idx], 2)}`
        );
      }
    }

    progress(chunk.length);
  }
}

function makeFlashProgressLogger(label, totalBytes) {
  let completed = 0;
  let lastPrinted = 0;

  return (delta) => {
    completed += delta;
    if ((completed - lastPrinted) < FLASH_PROGRESS_STEP && completed !== totalBytes) {
      return;
    }

    lastPrinted = completed;
    const percent = ((completed / totalBytes) * 100).toFixed(1);
    flashLogMessage(`${label} ${completed}/${totalBytes} (${percent}%)`);
  };
}

function makeFlashFile(name, text) {
  if (typeof File === "function") {
    return new File([text], name, { type: "text/plain" });
  }

  return {
    name,
    async text() {
      return text;
    },
  };
}

function clearFlashPreset({ resetSelect = false } = {}) {
  flashPresetFile = null;
  if (resetSelect && flashPresetSelect) {
    flashPresetSelect.value = "";
  }
}

async function ensureFlashDeviceSelected() {
  if (flashDevice) {
    return flashDevice;
  }

  if (!flashSupportsWebUsb()) {
    throw new Error("WebUSB requires HTTPS or localhost in a Chromium browser");
  }
  if (!window.DAPjs) {
    throw new Error("DAPjs failed to load");
  }

  flashDevice = await navigator.usb.requestDevice({
    filters: [{ vendorId: FLASH_VENDOR_ID, productId: FLASH_PRODUCT_ID }],
  });
  flashLogMessage(`Selected probe ${(flashDevice.productName || "CMSIS-DAP")} ${(flashDevice.serialNumber || "")}`.trim());
  updateFlashUi();
  return flashDevice;
}

async function getFlashDap() {
  await ensureFlashDeviceSelected();

  if (flashDap) {
    return flashDap;
  }

  const transport = new window.DAPjs.WebUSB(flashDevice);
  flashDap = new window.DAPjs.CortexM(transport, FLASH_DAP_PROTOCOL_SWD, FLASH_SWD_CLOCK_HZ);
  await flashDap.connect();
  return flashDap;
}

async function closeFlashSession({ clearDevice = false } = {}) {
  if (flashDap) {
    await flashDap.disconnect().catch(() => {});
    flashDap = null;
  }

  if (flashDevice && flashDevice.opened) {
    await flashDevice.close().catch(() => {});
  }

  if (clearDevice) {
    flashDevice = null;
  }

  updateFlashUi();
}

async function connectFlashProbe() {
  await ensureFlashDeviceSelected();
  setFlashStatus("Probe selected");
}

async function disconnectFlashProbe() {
  await closeFlashSession({ clearDevice: true });
  setFlashStatus("Probe disconnected");
  flashLogMessage("Probe disconnected");
}

async function loadFlashPreset(imageId) {
  if (!imageId) {
    clearFlashPreset();
    setFlashStatus(flashCurrentFile() ? `Ready to flash ${flashCurrentFile().name}` : "Ready");
    updateFlashUi();
    return;
  }

  const image = firmwareImageMap.get(imageId);
  if (!image) {
    throw new Error(`Unknown firmware image: ${imageId}`);
  }

  flashBusy = true;
  updateFlashUi();
  setFlashStatus(`Loading built-in image ${image.name}...`);

  try {
    const response = await fetch(image.downloadUrl, { credentials: "same-origin" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while loading ${image.name}`);
    }

    const hexText = await response.text();
    flashPresetFile = makeFlashFile(image.name, hexText);
    if (flashFileInput) {
      flashFileInput.value = "";
    }
    flashLogMessage(`Loaded built-in image ${image.name}`);
    setFlashStatus(`Ready to flash ${image.name}`);
  } finally {
    flashBusy = false;
    updateFlashUi();
  }
}

async function flashEraseAll(actionLabel) {
  flashBusy = true;
  updateFlashUi();
  setFlashStatus(`${actionLabel} in progress...`);

  try {
    const dap = await getFlashDap();
    const ctrlApIdr = await dap.readAP(FLASH_CTRL_AP_IDR);
    const eraseProtectStatus = await dap.readAP(FLASH_CTRL_AP_ERASEPROTECTSTATUS);

    flashLogMessage(`CTRL-AP IDR ${flashFormatHex(ctrlApIdr)}`);
    flashLogMessage(`CTRL-AP ERASEPROTECTSTATUS ${flashFormatHex(eraseProtectStatus)}`);
    flashLogMessage(`Issuing CTRL-AP ERASEALL for ${actionLabel.toLowerCase()}`);

    await dap.writeAP(FLASH_CTRL_AP_ERASEALL, 1);
    await waitForCondition(async () => {
      const status = await dap.readAP(FLASH_CTRL_AP_ERASEALLSTATUS);
      if (status === 2) {
        return false;
      }
      if (status === 1) {
        return true;
      }
      throw new Error(`ERASEALLSTATUS returned ${flashFormatHex(status)}`);
    }, 30_000);

    await dap.writeAP(FLASH_CTRL_AP_RESET, 2);
    await dap.writeAP(FLASH_CTRL_AP_RESET, 0);

    flashLogMessage(`${actionLabel} completed successfully`);
    setFlashStatus(`${actionLabel} completed`);
  } finally {
    flashBusy = false;
    await closeFlashSession();
  }
}

async function flashSelectedFirmware() {
  const file = flashCurrentFile();

  if (!file) {
    throw new Error("Choose a .hex file first");
  }

  flashBusy = true;
  updateFlashUi();
  setFlashStatus(`Flashing ${file.name}...`);

  try {
    flashLogMessage(`Loading ${file.name}`);
    const hexText = await file.text();
    const segments = parseIntelHex(hexText);
    const totalBytes = segments.reduce((sum, segment) => sum + segment.data.length, 0);
    const dap = await getFlashDap();

    flashLogMessage(`Segments ${segments.length}`);
    flashLogMessage(`Total bytes ${totalBytes}`);

    const dpidr = await dap.readDP(FLASH_DP_DPIDR);
    flashLogMessage(`DPIDR ${flashFormatHex(dpidr)}`);

    await dap.halt();
    flashLogMessage("Core halted");

    await dap.writeMem32(FLASH_RRAMC_CONFIG, FLASH_WRITE_CONFIG);
    await waitFlashReady(dap);
    flashLogMessage(`RRAMC configured ${flashFormatHex(FLASH_WRITE_CONFIG)}`);

    const reportProgram = makeFlashProgressLogger("program", totalBytes);
    for (const segment of segments) {
      flashLogMessage(`Programming ${segment.data.length} bytes at ${flashFormatHex(segment.address)}`);
      await writeRramChunks(dap, segment, reportProgram);
    }

    await dap.writeMem32(FLASH_RRAMC_CONFIG, 0);
    flashLogMessage("RRAMC restored read-only");

    const reportVerify = makeFlashProgressLogger("verify", totalBytes);
    for (const segment of segments) {
      flashLogMessage(`Verifying ${segment.data.length} bytes at ${flashFormatHex(segment.address)}`);
      await verifyFlashSegment(dap, segment, reportVerify);
    }

    await dap.writeMem32(FLASH_AIRCR, FLASH_AIRCR_VECTKEY | FLASH_AIRCR_SYSRESETREQ);
    flashLogMessage("SYSRESETREQ sent");
    flashLogMessage("Flash and verify completed successfully");
    setFlashStatus(`Flash completed: ${file.name}`);
  } finally {
    flashBusy = false;
    await closeFlashSession();
  }
}

async function restoreFlashDevicePermission() {
  if (!flashSupportsWebUsb() || !navigator.usb.getDevices) {
    updateFlashUi();
    return;
  }

  const devices = await navigator.usb.getDevices();
  const remembered = devices.find(flashMatchesDevice) || null;
  if (remembered) {
    flashDevice = remembered;
    setFlashStatus("Probe permission restored");
  }

  updateFlashUi();
}

function currentDevice() {
  if (!deviceSelector) {
    return deviceMap.get(String(config.selectedDeviceId || "")) || null;
  }
  return deviceMap.get(deviceSelector.value) || null;
}

function updateSelectedDeviceUi() {
  const device = currentDevice();
  const namePrefix = (device && device.bleNamePrefix) || config.webShellNamePrefix || "XIAO-WebShell";

  if (selectedDeviceChip) {
    selectedDeviceChip.innerHTML = device
      ? `Device ID: <code>${device.wirelessDeviceId}</code>`
      : "No assigned device";
  }

  if (selectedTopicChip) {
    selectedTopicChip.innerHTML = device && device.uplinkTopic
      ? `Topic: <code>${device.uplinkTopic}</code>`
      : "No uplink topic configured";
  }

  if (bleNamePrefixLabel) {
    bleNamePrefixLabel.textContent = namePrefix;
  }

  config.webShellNamePrefix = namePrefix;
}

function appendTerminal(text) {
  bleTerminalRenderer.feed(text);
}

function setBleStatus(text) {
  bleStatus.textContent = text;
}

function setEventFeedStatus(text, state) {
  if (!eventFeedStatus) {
    return;
  }
  eventFeedStatus.textContent = text;
  eventFeedStatus.dataset.state = state;
  eventFeedStatus.classList.remove("live-badge--connecting", "live-badge--live", "live-badge--error");
  eventFeedStatus.classList.add(`live-badge--${state}`);
}

function renderEvent(event) {
  const card = document.createElement("article");
  card.className = "event-card event-card--fresh";

  const lines = [];
  lines.push(`${event.ts || ""} ${event.type}`);
  const device = deviceByWirelessId.get(event.wireless_device_id || "");

  if (event.device_name) {
    lines.push(`Device: ${event.device_name}`);
  } else if (device) {
    lines.push(`Device: ${device.name}`);
  }

  if (event.semantic === "button_press") {
    lines.push("Device event: button press");
  }

  if (event.link_name) {
    lines.push(`Link: ${event.link_name}`);
  }

  if (event.payload_text) {
    lines.push(`Payload: ${event.payload_text}`);
  } else if (event.payload_hex) {
    lines.push(`Payload hex: ${event.payload_hex}`);
  }

  if (event.detail) {
    lines.push(event.detail);
  }

  if (event.message_id) {
    lines.push(`MessageId: ${event.message_id}`);
  }

  if (event.raw) {
    lines.push(event.raw);
  }

  card.textContent = lines.join("\n");
  eventLog.prepend(card);
  eventLog.scrollTop = 0;
  window.setTimeout(() => {
    card.classList.remove("event-card--fresh");
  }, 1200);
}

function connectEventStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  if (eventReconnectTimer) {
    window.clearTimeout(eventReconnectTimer);
    eventReconnectTimer = null;
  }

  setEventFeedStatus("Connecting", "connecting");
  const params = new URLSearchParams();
  const device = currentDevice();
  if (device) {
    params.set("device", device.id);
  }
  const source = new EventSource(`/api/events?${params.toString()}`);
  eventSource = source;

  source.onopen = () => {
    eventReconnectDelay = 1000;
    setEventFeedStatus("Live", "live");
  };

  source.onmessage = (msg) => {
    const event = JSON.parse(msg.data);
    renderEvent(event);
  };

  source.onerror = () => {
    if (eventSource !== source) {
      return;
    }
    setEventFeedStatus("Reconnecting", "connecting");
    source.close();
    eventSource = null;
    if (!eventReconnectTimer) {
      eventReconnectTimer = window.setTimeout(() => {
        eventReconnectTimer = null;
        eventReconnectDelay = Math.min(eventReconnectDelay * 2, 15000);
        connectEventStream();
      }, eventReconnectDelay);
    }
  };
}

async function sendDownlink(payload, acked, messageType, seq) {
  const device = currentDevice();
  const response = await fetch("/api/downlink", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      deviceId: device ? device.id : null,
      payload,
      acked,
      messageType,
      seq,
    }),
  });
  return response.json();
}

async function connectBleShell() {
  if (!navigator.bluetooth) {
    setBleStatus("Web Bluetooth is not available in this browser");
    return;
  }

  const device = currentDevice();
  const namePrefix = (device && device.bleNamePrefix) || config.webShellNamePrefix || "XIAO-WebShell";
  setBleStatus(`Scanning for ${namePrefix}...`);
  bleDevice = await navigator.bluetooth.requestDevice({
    filters: [
      {
        namePrefix,
        services: [config.nusServiceUuid],
      },
    ],
    optionalServices: [config.nusServiceUuid],
  });

  bleDevice.addEventListener("gattserverdisconnected", () => {
    const tail = textDecoder.decode();
    if (tail) {
      appendTerminal(tail);
    }
    setBleStatus("Disconnected");
    appendTerminal("\n[disconnected]\n");
  });

  bleServer = await bleDevice.gatt.connect();
  const service = await bleServer.getPrimaryService(config.nusServiceUuid);
  bleRxCharacteristic = await service.getCharacteristic(config.nusRxUuid);
  bleTxCharacteristic = await service.getCharacteristic(config.nusTxUuid);

  await bleTxCharacteristic.startNotifications();
  bleTxCharacteristic.addEventListener("characteristicvaluechanged", (event) => {
    const chunk = textDecoder.decode(event.target.value, { stream: true });
    appendTerminal(chunk);
  });

  setBleStatus(`Connected to ${bleDevice.name || "Sidewalk device"}`);
  appendTerminal(`[connected ${bleDevice.name || "device"}]\n`);
}

async function disconnectBleShell() {
  if (bleDevice && bleDevice.gatt.connected) {
    bleDevice.gatt.disconnect();
  }
}

async function sendBleCommand(command) {
  if (!bleRxCharacteristic) {
    throw new Error("BLE shell is not connected");
  }
  const bytes = textEncoder.encode(`${command}\n`);
  await bleRxCharacteristic.writeValue(bytes);
}

if (downlinkForm) {
  downlinkForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    downlinkStatus.textContent = "Sending...";
    const result = await sendDownlink(
      payloadInput.value,
      ackedInput.checked,
      messageTypeInput.value,
      seqInput.value || null,
    );
    downlinkStatus.textContent = JSON.stringify(result, null, 2);
  });
}

if (bleConnectButton) {
  bleConnectButton.addEventListener("click", async () => {
    try {
      await connectBleShell();
    } catch (error) {
      setBleStatus(`BLE error: ${error.message}`);
    }
  });
}

if (bleDisconnectButton) {
  bleDisconnectButton.addEventListener("click", async () => {
    await disconnectBleShell();
  });
}

if (bleCommandForm) {
  bleCommandForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const command = bleCommandInput.value.trim();
    if (!command) {
      return;
    }
    appendTerminal(`\n> ${command}\n`);
    try {
      await sendBleCommand(command);
      bleCommandInput.value = "";
    } catch (error) {
      appendTerminal(`[error] ${error.message}\n`);
    }
  });
}

if (deviceSelector) {
  deviceSelector.addEventListener("change", () => {
    updateSelectedDeviceUi();
    connectEventStream();
  });
}

if (flashConnectButton) {
  flashConnectButton.addEventListener("click", async () => {
    try {
      await connectFlashProbe();
    } catch (error) {
      const message = error.message || String(error);
      setFlashStatus(`Probe error: ${message}`);
      flashLogMessage(`Probe error: ${message}`);
      updateFlashUi();
    }
  });
}

if (flashDisconnectButton) {
  flashDisconnectButton.addEventListener("click", async () => {
    await disconnectFlashProbe();
  });
}

if (flashButton) {
  flashButton.addEventListener("click", async () => {
    try {
      await flashSelectedFirmware();
    } catch (error) {
      const message = error.message || String(error);
      setFlashStatus(`Flash failed: ${message}`);
      flashLogMessage(`Flash failed: ${message}`);
      updateFlashUi();
    }
  });
}

if (flashEraseButton) {
  flashEraseButton.addEventListener("click", async () => {
    try {
      await flashEraseAll("Erase");
    } catch (error) {
      const message = error.message || String(error);
      setFlashStatus(`Erase failed: ${message}`);
      flashLogMessage(`Erase failed: ${message}`);
      updateFlashUi();
    }
  });
}

if (flashRecoverButton) {
  flashRecoverButton.addEventListener("click", async () => {
    try {
      await flashEraseAll("Recover / unlock");
    } catch (error) {
      const message = error.message || String(error);
      setFlashStatus(`Recover failed: ${message}`);
      flashLogMessage(`Recover failed: ${message}`);
      updateFlashUi();
    }
  });
}

if (flashClearLogButton) {
  flashClearLogButton.addEventListener("click", () => {
    flashLogLines = [];
    if (flashLog) {
      flashLog.textContent = "";
    }
  });
}

if (flashFileInput) {
  flashFileInput.addEventListener("change", () => {
    clearFlashPreset({ resetSelect: true });
    const file = flashCurrentFile();
    setFlashStatus(file ? `Ready to flash ${file.name}` : "Ready");
    updateFlashUi();
  });
}

if (flashPresetSelect) {
  flashPresetSelect.addEventListener("change", async () => {
    try {
      await loadFlashPreset(flashPresetSelect.value);
    } catch (error) {
      const message = error.message || String(error);
      clearFlashPreset({ resetSelect: true });
      setFlashStatus(`Preset load failed: ${message}`);
      flashLogMessage(`Preset load failed: ${message}`);
      updateFlashUi();
    }
  });
}

if (navigator.usb) {
  navigator.usb.addEventListener("disconnect", async (event) => {
    if (!flashDevice || event.device !== flashDevice) {
      return;
    }

    await closeFlashSession({ clearDevice: true });
    setFlashStatus("Probe disconnected");
    flashLogMessage("Probe removed");
  });
}

updateSelectedDeviceUi();
connectEventStream();
updateFlashUi();
restoreFlashDevicePermission().catch((error) => {
  flashLogMessage(`Probe restore failed: ${error.message || error}`);
  updateFlashUi();
});
