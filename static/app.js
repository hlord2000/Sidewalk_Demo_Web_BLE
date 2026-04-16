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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");
const devices = config.devices || [];
const deviceMap = new Map(devices.map((device) => [String(device.id), device]));
const deviceByWirelessId = new Map(devices.map((device) => [device.wirelessDeviceId, device]));

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

updateSelectedDeviceUi();
connectEventStream();
