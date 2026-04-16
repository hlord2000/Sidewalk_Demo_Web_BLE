const config = window.DEMO_CONFIG;

const downlinkForm = document.getElementById("downlink-form");
const payloadInput = document.getElementById("payload");
const ackedInput = document.getElementById("acked");
const messageTypeInput = document.getElementById("message-type");
const seqInput = document.getElementById("seq");
const downlinkStatus = document.getElementById("downlink-status");
const eventLog = document.getElementById("event-log");

const bleStatus = document.getElementById("ble-status");
const bleTerminal = document.getElementById("ble-terminal");
const bleCommandForm = document.getElementById("ble-command-form");
const bleCommandInput = document.getElementById("ble-command");
const bleConnectButton = document.getElementById("ble-connect");
const bleDisconnectButton = document.getElementById("ble-disconnect");
const eventFeedStatus = document.getElementById("event-feed-status");
const dapStatusBadge = document.getElementById("dap-status-badge");
const dapProbeName = document.getElementById("dap-probe-name");
const dapTargetName = document.getElementById("dap-target-name");
const dapConnectButton = document.getElementById("dap-connect");
const dapDisconnectButton = document.getElementById("dap-disconnect");
const dapResetButton = document.getElementById("dap-reset");
const firmwareForm = document.getElementById("firmware-form");
const firmwareFileInput = document.getElementById("firmware-file");
const firmwareAddressInput = document.getElementById("firmware-address");
const firmwareProgress = document.getElementById("firmware-progress");
const firmwareStatus = document.getElementById("firmware-status");
const firmwareFlashButton = document.getElementById("firmware-flash");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");
const DAPjs = window.DAPjs || null;
const DAP_FILTERS = [
  { vendorId: 0x0d28 },
  { classCode: 0xff, subclassCode: 0x00, protocolCode: 0x00 },
];
const DAP_INFO_REQUEST = (DAPjs && DAPjs.DAPInfoRequest) || {
  VENDOR_ID: 0x01,
  PRODUCT_ID: 0x02,
  SERIAL_NUMBER: 0x03,
  CMSIS_DAP_FW_VERSION: 0x04,
  TARGET_DEVICE_VENDOR: 0x05,
  TARGET_DEVICE_NAME: 0x06,
  PACKET_COUNT: 0xfe,
  PACKET_SIZE: 0xff,
};
const CORE_REGISTER = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R9: 9,
  SP: 13,
  LR: 14,
  PC: 15,
  XPSR: 16,
};
const FLASH_OPERATION = {
  ERASE: 1,
  PROGRAM: 2,
};
const XPSR_THUMB = 0x01000000;
const ARM_DEBUG = {
  DFSR: 0xe000ed30,
  DHCSR: 0xe000edf0,
  DBGKEY: 0xa05f << 16,
  C_DEBUGEN: 1 << 0,
  C_HALT: 1 << 1,
  S_HALT: 1 << 17,
  CLEAR_ALL_DEBUG_EVENTS: 0x1f,
};
const NRF54L15_FLASH_ALGO = {
  loadAddress: 0x20000000,
  instructions: [
    0xe00abe00,
    0xf8d24a02, 0x2b013400, 0x4770d1fb, 0x5004b000, 0x47702000, 0x47702000, 0x49072001, 0xf8c1b508,
    0xf7ff0500, 0xf8c1ffed, 0x20000540, 0xffe8f7ff, 0x0500f8c1, 0xbf00bd08, 0x5004b000, 0x2301b508,
    0xf8c14906, 0xf7ff3500, 0xf04fffdb, 0x600333ff, 0xf7ff2000, 0xf8c1ffd5, 0xbd080500, 0x5004b000,
    0x2301b538, 0x4d0c4614, 0x0103f021, 0x3500f8c5, 0xffc6f7ff, 0x44214622, 0x42911b00, 0x2000d105,
    0xffbef7ff, 0x0500f8c5, 0x4613bd38, 0x4b04f853, 0x461a5014, 0xbf00e7f1, 0x5004b000, 0x00000000,
  ],
  pcInit: 0x20000015,
  pcUnInit: 0x20000019,
  pcProgramPage: 0x20000065,
  pcEraseSector: 0x20000041,
  staticBase: 0x200000a4,
  beginStack: 0x20000300,
  pageBuffer: 0x20001000,
  flashStart: 0x00000000,
  flashSize: 0x0017d000,
};
const NRF54L15_FLASH_REGIONS = [
  {
    name: "Application Flash",
    start: 0x00000000,
    length: 0x0017d000,
    pageSize: 0x1000,
    sectorSize: 0x1000,
    erasable: true,
  },
  {
    name: "UICR",
    start: 0x00ffd000,
    length: 0x00001000,
    pageSize: 0x4,
    sectorSize: 0x4,
    erasable: false,
  },
];

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

function isNearBottom(element, tolerance = 24) {
  return element.scrollHeight - (element.scrollTop + element.clientHeight) <= tolerance;
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
    const stickToBottom = isNearBottom(this.element);
    const previousScrollTop = this.element.scrollTop;
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
    if (stickToBottom) {
      this.element.scrollTop = this.element.scrollHeight;
    } else {
      this.element.scrollTop = previousScrollTop;
    }
  }
}

let bleDevice = null;
let bleServer = null;
let bleRxCharacteristic = null;
let bleTxCharacteristic = null;
let dapDevice = null;
let dapLink = null;
let dapTarget = null;
let eventSource = null;
let eventReconnectTimer = null;
let eventReconnectDelay = 1000;
let dapConnectInProgress = false;
let dapFlashInProgress = false;
let activeFirmwareName = "";
const bleTerminalRenderer = new TerminalRenderer(bleTerminal);

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

function setDapStatus(text, state) {
  if (!dapStatusBadge) {
    return;
  }
  dapStatusBadge.textContent = text;
  dapStatusBadge.dataset.state = state;
  dapStatusBadge.classList.remove(
    "live-badge--idle",
    "live-badge--connecting",
    "live-badge--live",
    "live-badge--error",
  );
  dapStatusBadge.classList.add(`live-badge--${state}`);
}

function setFirmwareStatus(text) {
  if (!firmwareStatus) {
    return;
  }
  firmwareStatus.textContent = text;
}

function setFirmwareProgress(value) {
  if (!firmwareProgress) {
    return;
  }
  firmwareProgress.value = Math.max(0, Math.min(1, value));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes || 0} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatHex(value, width = 8) {
  const normalized = Number.isFinite(value) ? value >>> 0 : 0;
  return `0x${normalized.toString(16).padStart(width, "0")}`;
}

function alignDown(value, alignment) {
  return Math.floor(value / alignment) * alignment;
}

function byteArraysEqual(left, right) {
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function bytesToWords(bytes, fillByte = 0x00) {
  const wordCount = Math.ceil(bytes.length / 4);
  const padded = new Uint8Array(wordCount * 4);
  padded.fill(fillByte);
  padded.set(bytes);

  const words = new Uint32Array(wordCount);
  for (let index = 0; index < wordCount; index += 1) {
    const base = index * 4;
    words[index] =
      padded[base] |
      (padded[base + 1] << 8) |
      (padded[base + 2] << 16) |
      (padded[base + 3] << 24);
  }

  return words;
}

function wordsToBytes(words, requestedLength = words.length * 4) {
  const bytes = new Uint8Array(words.length * 4);
  for (let index = 0; index < words.length; index += 1) {
    const value = words[index] >>> 0;
    const base = index * 4;
    bytes[base] = value & 0xff;
    bytes[base + 1] = (value >>> 8) & 0xff;
    bytes[base + 2] = (value >>> 16) & 0xff;
    bytes[base + 3] = (value >>> 24) & 0xff;
  }

  return requestedLength === bytes.length ? bytes : bytes.slice(0, requestedLength);
}

async function readTargetBytes(target, address, length) {
  if (length === 0) {
    return new Uint8Array(0);
  }
  if (address % 4 !== 0 || length % 4 !== 0) {
    throw new Error(`Target read must be word-aligned: ${formatHex(address)} (${length} bytes)`);
  }

  const words = await target.readBlock(address, length / 4);
  return wordsToBytes(words, length);
}

async function writeTargetBytes(target, address, bytes) {
  if (bytes.length === 0) {
    return;
  }
  if (address % 4 !== 0 || bytes.length % 4 !== 0) {
    throw new Error(`Target write must be word-aligned: ${formatHex(address)} (${bytes.length} bytes)`);
  }

  await target.writeBlock(address, bytesToWords(bytes));
}

function parseNumericAddress(value) {
  const trimmed = `${value || ""}`.trim();
  if (!trimmed) {
    return 0;
  }

  let parsed = Number.NaN;
  if (/^0x[0-9a-f]+$/i.test(trimmed)) {
    parsed = Number.parseInt(trimmed, 16);
  } else if (/^[0-9]+$/i.test(trimmed)) {
    parsed = Number.parseInt(trimmed, 10);
  } else if (/^[0-9a-f]+$/i.test(trimmed)) {
    parsed = Number.parseInt(trimmed, 16);
  }

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid flash address: ${trimmed}`);
  }

  return parsed;
}

function isHexImageFile(file) {
  return Boolean(file && typeof file.name === "string" && file.name.toLowerCase().endsWith(".hex"));
}

function hasValidFirmwareAddress(file) {
  if (!file || isHexImageFile(file)) {
    return true;
  }

  try {
    parseNumericAddress(firmwareAddressInput ? firmwareAddressInput.value : "0x00000000");
    return true;
  } catch (error) {
    return false;
  }
}

function parseIntelHex(text) {
  const segments = [];
  let upperAddress = 0;
  let eofSeen = false;
  const lines = text.split(/\r?\n/);

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber].trim();
    if (!line) {
      continue;
    }
    if (!line.startsWith(":")) {
      throw new Error(`Invalid Intel HEX record on line ${lineNumber + 1}`);
    }

    const record = line.slice(1);
    if (record.length < 10 || record.length % 2 !== 0) {
      throw new Error(`Malformed Intel HEX record on line ${lineNumber + 1}`);
    }

    const byteCount = Number.parseInt(record.slice(0, 2), 16);
    const address = Number.parseInt(record.slice(2, 6), 16);
    const recordType = Number.parseInt(record.slice(6, 8), 16);
    const dataHex = record.slice(8, 8 + byteCount * 2);
    const checksum = Number.parseInt(record.slice(8 + byteCount * 2, 10 + byteCount * 2), 16);

    if (
      Number.isNaN(byteCount) ||
      Number.isNaN(address) ||
      Number.isNaN(recordType) ||
      Number.isNaN(checksum) ||
      dataHex.length !== byteCount * 2 ||
      record.length !== 10 + byteCount * 2
    ) {
      throw new Error(`Malformed Intel HEX record on line ${lineNumber + 1}`);
    }

    const bytes = new Uint8Array(byteCount);
    let checksumTotal = byteCount + ((address >>> 8) & 0xff) + (address & 0xff) + recordType;

    for (let index = 0; index < byteCount; index += 1) {
      const value = Number.parseInt(dataHex.slice(index * 2, index * 2 + 2), 16);
      if (Number.isNaN(value)) {
        throw new Error(`Malformed Intel HEX data on line ${lineNumber + 1}`);
      }
      bytes[index] = value;
      checksumTotal += value;
    }

    checksumTotal = (checksumTotal + checksum) & 0xff;
    if (checksumTotal !== 0) {
      throw new Error(`Intel HEX checksum mismatch on line ${lineNumber + 1}`);
    }

    if (recordType === 0x00) {
      if (bytes.length === 0) {
        continue;
      }
      segments.push({
        address: upperAddress + address,
        data: bytes,
      });
    } else if (recordType === 0x01) {
      eofSeen = true;
      break;
    } else if (recordType === 0x02) {
      if (bytes.length !== 2) {
        throw new Error(`Bad extended segment address on line ${lineNumber + 1}`);
      }
      upperAddress = ((bytes[0] << 8) | bytes[1]) << 4;
    } else if (recordType === 0x04) {
      if (bytes.length !== 2) {
        throw new Error(`Bad extended linear address on line ${lineNumber + 1}`);
      }
      upperAddress = ((bytes[0] << 8) | bytes[1]) << 16;
    } else if (recordType === 0x03 || recordType === 0x05) {
      continue;
    } else {
      throw new Error(`Unsupported Intel HEX record type ${formatHex(recordType, 2)} on line ${lineNumber + 1}`);
    }
  }

  if (!segments.length) {
    throw new Error(eofSeen ? "The Intel HEX file does not contain flash data." : "The Intel HEX file is empty.");
  }

  return segments.sort((left, right) => left.address - right.address);
}

function wordToAscii(value) {
  return String.fromCharCode(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  )
    .replace(/[^\x20-\x7e]+/g, "")
    .trim();
}

async function detectNordicTargetName(target) {
  try {
    const partNumber = await target.readMem32(0x00ffc31c);
    if (!partNumber || partNumber === 0xffffffff) {
      return null;
    }

    const variantWord = await target.readMem32(0x00ffc320);
    const variant = wordToAscii(variantWord);
    return variant ? `Nordic nRF${partNumber.toString(16).toUpperCase()} ${variant}` : `Nordic nRF${partNumber.toString(16).toUpperCase()}`;
  } catch (error) {
    return null;
  }
}

function getFlashRegionForAddress(address) {
  return (
    NRF54L15_FLASH_REGIONS.find((region) => address >= region.start && address < region.start + region.length) || null
  );
}

function splitSegmentAcrossRegions(segment) {
  const slices = [];
  let offset = 0;

  while (offset < segment.data.length) {
    const absoluteAddress = segment.address + offset;
    const region = getFlashRegionForAddress(absoluteAddress);
    if (!region) {
      throw new Error(`Image data at ${formatHex(absoluteAddress)} is outside the supported nRF54L15 flash regions.`);
    }

    const availableInRegion = region.start + region.length - absoluteAddress;
    const sliceLength = Math.min(segment.data.length - offset, availableInRegion);

    slices.push({
      region,
      address: absoluteAddress,
      data: segment.data.slice(offset, offset + sliceLength),
    });

    offset += sliceLength;
  }

  return slices;
}

function collectFlashPages(segments) {
  const pages = new Map();

  for (const segment of segments) {
    for (const slice of splitSegmentAcrossRegions(segment)) {
      let offset = 0;

      while (offset < slice.data.length) {
        const absoluteAddress = slice.address + offset;
        const pageAddress = alignDown(absoluteAddress, slice.region.pageSize);
        const pageOffset = absoluteAddress - pageAddress;
        const chunkLength = Math.min(slice.data.length - offset, slice.region.pageSize - pageOffset);
        const pageKey = `${slice.region.start}:${pageAddress}`;

        let page = pages.get(pageKey);
        if (!page) {
          page = {
            region: slice.region,
            address: pageAddress,
            overlays: [],
          };
          pages.set(pageKey, page);
        }

        page.overlays.push({
          offset: pageOffset,
          data: slice.data.slice(offset, offset + chunkLength),
        });

        offset += chunkLength;
      }
    }
  }

  return Array.from(pages.values()).sort((left, right) => left.address - right.address);
}

async function buildFlashPlan(target, segments, onProgress) {
  const requestedPages = collectFlashPages(segments);
  const changedPages = [];

  for (let index = 0; index < requestedPages.length; index += 1) {
    const page = requestedPages[index];
    const existing = await readTargetBytes(target, page.address, page.region.pageSize);
    const desired = existing.slice();

    for (const overlay of page.overlays) {
      desired.set(overlay.data, overlay.offset);
    }

    if (!byteArraysEqual(existing, desired)) {
      if (!page.region.erasable) {
        for (let byteIndex = 0; byteIndex < desired.length; byteIndex += 1) {
          if ((existing[byteIndex] & desired[byteIndex]) !== desired[byteIndex]) {
            throw new Error(
              `UICR word at ${formatHex(page.address)} needs an erase before it can be rewritten. ` +
                "Use an external tool to clear UICR, then try the WebUSB update again.",
            );
          }
        }
      }

      changedPages.push({
        region: page.region,
        address: page.address,
        data: desired,
      });
    }

    if (onProgress) {
      onProgress({
        page,
        current: index + 1,
        total: requestedPages.length,
      });
    }
  }

  return {
    requestedPages,
    changedPages,
  };
}

async function isTargetHalted(target) {
  const dhcsr = await target.readMem32(ARM_DEBUG.DHCSR);
  return (dhcsr & ARM_DEBUG.S_HALT) !== 0;
}

async function haltTarget(target) {
  await target.writeMem32(ARM_DEBUG.DHCSR, (ARM_DEBUG.DBGKEY | ARM_DEBUG.C_DEBUGEN | ARM_DEBUG.C_HALT) >>> 0);
}

async function resumeTarget(target) {
  await target.writeMem32(ARM_DEBUG.DFSR, ARM_DEBUG.CLEAR_ALL_DEBUG_EVENTS >>> 0);
  await target.writeMem32(ARM_DEBUG.DHCSR, (ARM_DEBUG.DBGKEY | ARM_DEBUG.C_DEBUGEN) >>> 0);
}

async function readTargetDebugSnapshot(target) {
  const [pc, lr, dhcsr, dfsr] = await Promise.all([
    target.readCoreRegister(CORE_REGISTER.PC).catch(() => null),
    target.readCoreRegister(CORE_REGISTER.LR).catch(() => null),
    target.readMem32(ARM_DEBUG.DHCSR).catch(() => null),
    target.readMem32(ARM_DEBUG.DFSR).catch(() => null),
  ]);

  return {
    pc,
    lr,
    dhcsr,
    dfsr,
  };
}

function formatDebugSnapshot(snapshot) {
  return [
    snapshot.pc == null ? null : `PC=${formatHex(snapshot.pc)}`,
    snapshot.lr == null ? null : `LR=${formatHex(snapshot.lr)}`,
    snapshot.dhcsr == null ? null : `DHCSR=${formatHex(snapshot.dhcsr)}`,
    snapshot.dfsr == null ? null : `DFSR=${formatHex(snapshot.dfsr)}`,
  ]
    .filter(Boolean)
    .join(" ");
}

async function waitForTargetHalt(target, timeoutMs = 10000, label = "target operation") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isTargetHalted(target)) {
      return;
    }
    await delay(20);
  }

  await haltTarget(target);
  const snapshot = await readTargetDebugSnapshot(target);
  const debugText = formatDebugSnapshot(snapshot);
  throw new Error(
    debugText
      ? `Timed out waiting for the target to halt during ${label}. ${debugText}`
      : `Timed out waiting for the target to halt during ${label}.`,
  );
}

class Nrf54FlashRunner {
  constructor(target, algorithm) {
    this.target = target;
    this.algorithm = algorithm;
    this.prepared = false;
    this.activeOperation = null;
  }

  async prepare() {
    if (this.prepared) {
      return;
    }

    await haltTarget(this.target);
    await this.target.writeBlock(this.algorithm.loadAddress, new Uint32Array(this.algorithm.instructions));
    this.prepared = true;
  }

  async call(label, pc, registers = {}, timeoutMs = 10000) {
    await haltTarget(this.target);
    await this.target.writeCoreRegister(CORE_REGISTER.R9, this.algorithm.staticBase >>> 0);
    await this.target.writeCoreRegister(CORE_REGISTER.SP, this.algorithm.beginStack >>> 0);
    await this.target.writeCoreRegister(CORE_REGISTER.XPSR, XPSR_THUMB >>> 0);
    await this.target.writeCoreRegister(CORE_REGISTER.LR, (this.algorithm.loadAddress + 1) >>> 0);
    await this.target.writeCoreRegister(CORE_REGISTER.PC, pc >>> 0);

    for (const [name, register] of [
      ["r0", CORE_REGISTER.R0],
      ["r1", CORE_REGISTER.R1],
      ["r2", CORE_REGISTER.R2],
      ["r3", CORE_REGISTER.R3],
    ]) {
      if (registers[name] !== undefined && registers[name] !== null) {
        await this.target.writeCoreRegister(register, registers[name] >>> 0);
      }
    }

    await resumeTarget(this.target);
    await waitForTargetHalt(this.target, timeoutMs, label);
    return (await this.target.readCoreRegister(CORE_REGISTER.R0)) >>> 0;
  }

  async init(operation, address = this.algorithm.flashStart) {
    if (this.activeOperation === operation) {
      return;
    }

    if (this.activeOperation !== null) {
      await this.uninit();
    }

    await this.prepare();
    const result = await this.call(
      `flash init at ${formatHex(address)}`,
      this.algorithm.pcInit,
      {
        r0: address,
        r1: 0,
        r2: operation,
      },
      10000,
    );

    if (result !== 0) {
      throw new Error(`Flash init failed with status ${formatHex(result)}`);
    }

    this.activeOperation = operation;
  }

  async uninit() {
    if (this.activeOperation === null) {
      return;
    }

    const result = await this.call(
      "flash uninit",
      this.algorithm.pcUnInit,
      {
        r0: this.activeOperation,
      },
      10000,
    );

    if (result !== 0) {
      throw new Error(`Flash uninit failed with status ${formatHex(result)}`);
    }

    this.activeOperation = null;
  }

  async eraseSector(address) {
    const result = await this.call(
      `erase sector ${formatHex(address)}`,
      this.algorithm.pcEraseSector,
      {
        r0: address,
      },
      30000,
    );

    if (result !== 0) {
      throw new Error(`Erase failed at ${formatHex(address)} with status ${formatHex(result)}`);
    }
  }

  async programPage(address, data) {
    await writeTargetBytes(this.target, this.algorithm.pageBuffer, data);
    const result = await this.call(
      `program page ${formatHex(address)} (${data.length} bytes)`,
      this.algorithm.pcProgramPage,
      {
        r0: address,
        r1: data.length,
        r2: this.algorithm.pageBuffer,
      },
      30000,
    );

    if (result !== 0) {
      throw new Error(`Program failed at ${formatHex(address)} with status ${formatHex(result)}`);
    }
  }

  async cleanup() {
    try {
      await this.uninit();
    } catch (error) {
      console.warn("Flash runner cleanup failed", error);
    }
  }
}

function updateFirmwareControls() {
  const dapConnected = Boolean(dapLink && dapLink.connected);
  const selectedFirmwareFile = firmwareFileInput && firmwareFileInput.files ? firmwareFileInput.files[0] : null;
  const hasFirmwareFile = Boolean(selectedFirmwareFile);
  const hasValidFirmwareImage = hasFirmwareFile && hasValidFirmwareAddress(selectedFirmwareFile);
  const controlsBusy = dapConnectInProgress || dapFlashInProgress;

  if (dapConnectButton) {
    dapConnectButton.disabled = controlsBusy;
  }
  if (dapDisconnectButton) {
    dapDisconnectButton.disabled = !dapConnected || controlsBusy;
  }
  if (dapResetButton) {
    dapResetButton.disabled = !dapConnected || controlsBusy;
  }
  if (firmwareFileInput) {
    firmwareFileInput.disabled = controlsBusy;
  }
  if (firmwareAddressInput) {
    firmwareAddressInput.disabled = controlsBusy;
  }
  if (firmwareFlashButton) {
    firmwareFlashButton.disabled = !dapConnected || !hasValidFirmwareImage || controlsBusy;
  }
}

function updateDapNames(probeName, targetName) {
  if (dapProbeName) {
    dapProbeName.textContent = probeName;
  }
  if (dapTargetName) {
    dapTargetName.textContent = targetName;
  }
}

async function getDapInfoValue(link, request) {
  try {
    const value = await link.dapInfo(request);
    if (typeof value === "string") {
      return value.trim();
    }
    return value;
  } catch (error) {
    return null;
  }
}

async function ensureDapTarget() {
  if (!dapLink || !dapLink.connected) {
    throw new Error("No CMSIS-DAP probe is connected.");
  }

  if (!dapTarget) {
    dapTarget = new DAPjs.CortexM(dapLink);
    await dapTarget.connect();
  }

  return dapTarget;
}

async function disconnectDapLink(options = {}) {
  const {
    badgeText = "Disconnected",
    badgeState = "idle",
    statusText = "Disconnected",
    resetProgress = true,
  } = options;
  const activeLink = dapLink;
  dapLink = null;
  dapTarget = null;
  dapDevice = null;
  activeFirmwareName = "";

  if (activeLink && activeLink.connected) {
    try {
      await activeLink.disconnect();
    } catch (error) {
      console.warn("DAP disconnect failed", error);
    }
  }

  updateDapNames("No probe selected", "Unknown");
  setDapStatus(badgeText, badgeState);
  if (statusText) {
    setFirmwareStatus(statusText);
  }
  if (resetProgress) {
    setFirmwareProgress(0);
  }
  updateFirmwareControls();
}

async function refreshDapMetadata(link, device, options = {}) {
  const { statusPrefix = "Connected to", targetNameOverride = null } = options;
  const [
    vendorId,
    productId,
    serialNumber,
    firmwareVersion,
    packetCount,
    packetSize,
    targetVendor,
    targetName,
  ] = await Promise.all([
    getDapInfoValue(link, DAP_INFO_REQUEST.VENDOR_ID),
    getDapInfoValue(link, DAP_INFO_REQUEST.PRODUCT_ID),
    getDapInfoValue(link, DAP_INFO_REQUEST.SERIAL_NUMBER),
    getDapInfoValue(link, DAP_INFO_REQUEST.CMSIS_DAP_FW_VERSION),
    getDapInfoValue(link, DAP_INFO_REQUEST.PACKET_COUNT),
    getDapInfoValue(link, DAP_INFO_REQUEST.PACKET_SIZE),
    getDapInfoValue(link, DAP_INFO_REQUEST.TARGET_DEVICE_VENDOR),
    getDapInfoValue(link, DAP_INFO_REQUEST.TARGET_DEVICE_NAME),
  ]);

  const probeName = [vendorId, productId].filter(Boolean).join(" ") || device.productName || "CMSIS-DAP probe";
  const targetLabel = targetNameOverride || [targetVendor, targetName].filter(Boolean).join(" ") || "Unknown";

  updateDapNames(probeName, targetLabel);
  setFirmwareStatus(
    [
      `${statusPrefix} ${probeName}`,
      serialNumber ? `Serial: ${serialNumber}` : null,
      firmwareVersion ? `DAP firmware: ${firmwareVersion}` : null,
      Number.isFinite(packetCount) ? `Packet count: ${packetCount}` : null,
      Number.isFinite(packetSize) ? `Packet size: ${packetSize} bytes` : null,
      `Target: ${targetLabel}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

async function connectDapLink() {
  if (!navigator.usb || !navigator.usb.requestDevice) {
    setDapStatus("Unavailable", "error");
    setFirmwareStatus("WebUSB is not available in this browser. Use desktop Chromium.");
    return;
  }

  if (!DAPjs) {
    setDapStatus("Unavailable", "error");
    setFirmwareStatus("DAP.js did not load, so CMSIS-DAP control is unavailable.");
    return;
  }

  dapConnectInProgress = true;
  updateFirmwareControls();
  setDapStatus("Selecting", "connecting");
  setFirmwareStatus("Choose a WebUSB CMSIS-DAP probe from the browser picker.");

  try {
    const device = await navigator.usb.requestDevice({ filters: DAP_FILTERS });
    const link = new DAPjs.DAPLink(new DAPjs.WebUSB(device));
    const target = new DAPjs.CortexM(link);

    dapDevice = device;
    dapLink = link;
    dapTarget = target;

    setDapStatus("Connecting", "connecting");
    setFirmwareStatus(`Opening ${device.productName || "CMSIS-DAP probe"}...`);
    await link.connect();
    await target.connect();
    const detectedTargetName = await detectNordicTargetName(target);
    setDapStatus("Connected", "live");
    await refreshDapMetadata(link, device, { targetNameOverride: detectedTargetName });
  } catch (error) {
    if (dapLink && dapLink.connected) {
      try {
        await dapLink.disconnect();
      } catch (disconnectError) {
        console.warn("Probe cleanup failed", disconnectError);
      }
    }

    dapLink = null;
    dapTarget = null;
    dapDevice = null;

    if (error && error.name === "NotFoundError") {
      setDapStatus("Disconnected", "idle");
      setFirmwareStatus("No probe selected.");
    } else {
      setDapStatus("Connect failed", "error");
      setFirmwareStatus(`Probe connection failed: ${error.message || error}`);
    }
  } finally {
    dapConnectInProgress = false;
    updateFirmwareControls();
  }
}

async function resetDapTarget() {
  if (!dapLink || !dapLink.connected) {
    setFirmwareStatus("Connect a probe before trying to reset the target.");
    return;
  }

  try {
    const target = await ensureDapTarget();
    setFirmwareStatus("Sending target reset...");
    await target.reset();
    setDapStatus("Connected", "live");
    setFirmwareStatus("Target reset command sent over CMSIS-DAP.");
  } catch (error) {
    setDapStatus("Reset failed", "error");
    setFirmwareStatus(`Target reset failed: ${error.message || error}`);
  }
}

async function flashFirmwareImage() {
  if (!dapLink || !dapLink.connected) {
    setFirmwareStatus("Connect a probe before flashing firmware.");
    return;
  }

  const file = firmwareFileInput && firmwareFileInput.files ? firmwareFileInput.files[0] : null;
  if (!file) {
    setFirmwareStatus("Choose a .hex or .bin image first.");
    return;
  }

  dapFlashInProgress = true;
  activeFirmwareName = file.name;
  updateFirmwareControls();
  setDapStatus("Flashing", "connecting");
  setFirmwareProgress(0);

  try {
    const target = await ensureDapTarget();
    const imageBuffer = await file.arrayBuffer();
    const imageBytes = new Uint8Array(imageBuffer);
    const hexPreview = textDecoder.decode(imageBytes.slice(0, Math.min(imageBytes.length, 96)));
    const isHexImage = isHexImageFile(file) || /^\s*:/.test(hexPreview);
    const segments = isHexImage
      ? parseIntelHex(textDecoder.decode(imageBuffer))
      : [
          {
            address: parseNumericAddress(firmwareAddressInput ? firmwareAddressInput.value : "0x00000000"),
            data: imageBytes,
          },
        ];
    const payloadBytes = segments.reduce((total, segment) => total + segment.data.length, 0);
    const imageStart = Math.min(...segments.map((segment) => segment.address));
    const imageEnd = Math.max(...segments.map((segment) => segment.address + segment.data.length));

    setFirmwareProgress(0.05);
    setFirmwareStatus(
      [
        `Preparing ${file.name}`,
        `Format: ${isHexImage ? "Intel HEX" : "Raw binary"}`,
        `Payload: ${formatBytes(payloadBytes)}`,
        `Address span: ${formatHex(imageStart)} - ${formatHex(imageEnd - 1)}`,
        !isHexImage && firmwareAddressInput ? `Binary base address: ${formatHex(parseNumericAddress(firmwareAddressInput.value))}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    await haltTarget(target);
    const { requestedPages, changedPages } = await buildFlashPlan(target, segments, ({ page, current, total }) => {
      setFirmwareProgress(0.05 + (current / Math.max(total, 1)) * 0.25);
      setFirmwareStatus(
        [
          `Analyzing ${file.name}`,
          `Page ${current}/${total}: ${page.region.name} ${formatHex(page.address)}`,
          `Payload: ${formatBytes(payloadBytes)}`,
        ].join("\n"),
      );
    });

    if (!requestedPages.length) {
      throw new Error("The selected image did not contain supported flash data.");
    }

    if (!changedPages.length) {
      setFirmwareProgress(1);
      setDapStatus("Connected", "live");
      setFirmwareStatus(
        [
          `No flash changes were required for ${file.name}.`,
          `Checked ${requestedPages.length} page${requestedPages.length === 1 ? "" : "s"}.`,
        ].join("\n"),
      );
      return;
    }

    const erasablePages = changedPages.filter((page) => page.region.erasable);
    const directProgramPages = changedPages.filter((page) => !page.region.erasable);
    const runner = new Nrf54FlashRunner(target, NRF54L15_FLASH_ALGO);

    try {
      if (erasablePages.length) {
        await runner.init(FLASH_OPERATION.ERASE, erasablePages[0].address);
        for (let index = 0; index < erasablePages.length; index += 1) {
          const page = erasablePages[index];
          setFirmwareProgress(0.30 + ((index + 1) / erasablePages.length) * 0.25);
          setFirmwareStatus(
            [
              `Erasing ${page.region.name}`,
              `Sector ${index + 1}/${erasablePages.length}: ${formatHex(page.address)}`,
              `File: ${file.name}`,
            ].join("\n"),
          );
          await runner.eraseSector(page.address);
        }
        await runner.uninit();
      }

      const programGroups = [];
      if (erasablePages.length) {
        programGroups.push(erasablePages);
      }
      if (directProgramPages.length) {
        programGroups.push(directProgramPages);
      }

      let programmedCount = 0;
      for (const group of programGroups) {
        await runner.init(FLASH_OPERATION.PROGRAM, group[0].address);
        for (const page of group) {
          programmedCount += 1;
          setFirmwareProgress(0.55 + (programmedCount / changedPages.length) * 0.40);
          setFirmwareStatus(
            [
              `Programming ${page.region.name}`,
              `Page ${programmedCount}/${changedPages.length}: ${formatHex(page.address)}`,
              `Size: ${formatBytes(page.data.length)}`,
            ].join("\n"),
          );
          await runner.programPage(page.address, page.data);
        }
        await runner.uninit();
      }
    } finally {
      await runner.cleanup();
    }

    let resetNote = "Target reset command sent after programming.";
    try {
      setFirmwareProgress(0.97);
      await target.reset();
    } catch (resetError) {
      resetNote = `Programming finished, but target reset failed: ${resetError.message || resetError}`;
    }

    setFirmwareProgress(1);
    setDapStatus("Connected", "live");
    setFirmwareStatus(
      [
        `Flash complete: ${file.name}`,
        `Updated ${changedPages.length} of ${requestedPages.length} page${requestedPages.length === 1 ? "" : "s"}.`,
        resetNote,
      ].join("\n"),
    );
  } catch (error) {
    setDapStatus("Flash failed", "error");
    setFirmwareStatus(
      [
        `Flash failed: ${error.message || error}`,
        "This browser flow programs Nordic nRF54L15 flash through generic CMSIS-DAP WebUSB access.",
      ].join("\n"),
    );
  } finally {
    dapFlashInProgress = false;
    activeFirmwareName = "";
    updateFirmwareControls();
  }
}

function handleUsbDisconnect(event) {
  if (!dapDevice || event.device !== dapDevice) {
    return;
  }

  dapLink = null;
  dapTarget = null;
  dapDevice = null;
  activeFirmwareName = "";
  updateDapNames("No probe selected", "Unknown");
  setDapStatus("Disconnected", "idle");
  setFirmwareStatus("The WebUSB probe was disconnected.");
  setFirmwareProgress(0);
  updateFirmwareControls();
}

function renderEvent(event) {
  const card = document.createElement("article");
  card.className = "event-card event-card--fresh";
  const stickToTop = eventLog.scrollTop <= 12;
  const previousScrollHeight = eventLog.scrollHeight;

  const lines = [];
  lines.push([event.ts, event.type].filter(Boolean).join(" "));

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
    lines.push(`Message ID: ${event.message_id}`);
  }

  if (event.raw) {
    lines.push(event.raw);
  }

  card.textContent = lines.join("\n");
  eventLog.prepend(card);
  if (stickToTop) {
    eventLog.scrollTop = 0;
  } else {
    eventLog.scrollTop += eventLog.scrollHeight - previousScrollHeight;
  }
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
  const source = new EventSource("/api/events");
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
  const response = await fetch("/api/downlink", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
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

  const namePrefix = config.webShellNamePrefix || "XIAO-WebShell";
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

bleConnectButton.addEventListener("click", async () => {
  try {
    await connectBleShell();
  } catch (error) {
    setBleStatus(`BLE error: ${error.message}`);
  }
});

bleDisconnectButton.addEventListener("click", async () => {
  await disconnectBleShell();
});

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

if (firmwareFileInput) {
  firmwareFileInput.addEventListener("change", () => {
    const file = firmwareFileInput.files ? firmwareFileInput.files[0] : null;
    setFirmwareProgress(0);
    if (file) {
      let addressNote = "Intel HEX addresses come from the file.";
      if (!isHexImageFile(file)) {
        try {
          addressNote = `Binary base address: ${formatHex(parseNumericAddress(firmwareAddressInput ? firmwareAddressInput.value : "0x00000000"))}`;
        } catch (error) {
          addressNote = error.message || `${error}`;
        }
      }

      setFirmwareStatus([`Selected ${file.name}`, `Size: ${formatBytes(file.size)}`, addressNote].join("\n"));
    } else {
      setFirmwareStatus(
        dapLink && dapLink.connected
          ? "Probe connected.\nSelect a .hex or .bin image to start."
          : "Connect a WebUSB CMSIS-DAP probe to start.",
      );
    }
    updateFirmwareControls();
  });
}

if (firmwareAddressInput) {
  firmwareAddressInput.addEventListener("input", () => {
    updateFirmwareControls();
  });
}

if (dapConnectButton) {
  dapConnectButton.addEventListener("click", async () => {
    await connectDapLink();
  });
}

if (dapDisconnectButton) {
  dapDisconnectButton.addEventListener("click", async () => {
    await disconnectDapLink();
  });
}

if (dapResetButton) {
  dapResetButton.addEventListener("click", async () => {
    await resetDapTarget();
  });
}

if (firmwareForm) {
  firmwareForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await flashFirmwareImage();
  });
}

if (navigator.usb) {
  navigator.usb.addEventListener("disconnect", handleUsbDisconnect);
}

updateFirmwareControls();
connectEventStream();
