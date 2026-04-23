const FILTERS = [
  { vendorId: 0x2886, productId: 0x0066 },
  { vendorId: 0x0d28 },
];

const INFO_FIELDS = [
  { label: "Vendor ID", id: 0x01, format: "string", key: "vendor" },
  { label: "Product ID", id: 0x02, format: "string", key: "product" },
  { label: "Serial Number", id: 0x03, format: "string", key: "serial" },
  { label: "Firmware Version", id: 0x04, format: "string", key: "firmware" },
  { label: "Target Vendor", id: 0x05, format: "string", key: "targetVendor" },
  { label: "Target Name", id: 0x06, format: "string", key: "targetName" },
  { label: "Capabilities", id: 0xf0, format: "capabilities", key: "capabilities" },
  { label: "Packet Count", id: 0xfe, format: "u8", key: "packetCount" },
  { label: "Packet Size", id: 0xff, format: "u16", key: "packetSize" },
];

const requestButton = document.getElementById("request-device");
const authorizedButton = document.getElementById("use-authorized-device");
const disconnectButton = document.getElementById("disconnect-device");
const summaryBox = document.getElementById("probe-summary");
const infoBody = document.getElementById("probe-info-body");
const logElement = document.getElementById("probe-log");
const probeStatusBadge = document.getElementById("probe-status-badge");
const probeDeviceChip = document.getElementById("probe-device-chip");
const probeInterfaceChip = document.getElementById("probe-interface-chip");
const probePacketChip = document.getElementById("probe-packet-chip");
const usbSupportValue = document.getElementById("usb-support-value");
const authorizedCountValue = document.getElementById("authorized-count-value");
const lastResultValue = document.getElementById("last-result-value");

const smokeState = {
  phase: "booting",
  ok: false,
  error: "",
  summary: "",
  selectedDevice: "",
  usbId: "",
  interfaceLabel: "",
  interfaceNumber: null,
  outEndpoint: null,
  inEndpoint: null,
  packetSize: 64,
  dapPort: "",
  info: {},
  logs: [],
};

const session = {
  device: null,
  interfaceNumber: null,
  outEndpoint: null,
  inEndpoint: null,
  packetSize: 64,
  deviceLabel: "",
  interfaceLabel: "",
};

window.__webusbSmokeResult = {
  ...smokeState,
  info: {},
  logs: [],
};

function cloneState() {
  return {
    ...smokeState,
    info: { ...smokeState.info },
    logs: smokeState.logs.slice(),
  };
}

function commitState() {
  window.__webusbSmokeResult = cloneState();
  lastResultValue.textContent = smokeState.phase === "error" ? "Failed" : smokeState.ok ? "Passed" : humanizePhase(smokeState.phase);
}

function humanizePhase(value) {
  if (!value) {
    return "Idle";
  }
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function setPhase(phase, extras = {}) {
  smokeState.phase = phase;
  Object.assign(smokeState, extras);
  commitState();
}

function setBadge(kind, text) {
  const className = kind === "error" ? "live-badge--error" : kind === "live" ? "live-badge--live" : "live-badge--connecting";
  probeStatusBadge.className = `live-badge ${className}`;
  probeStatusBadge.textContent = text;
}

function appendLog(level, message) {
  const timestamp = new Date().toLocaleTimeString();
  smokeState.logs.push({ level, message, timestamp });
  commitState();

  const card = document.createElement("article");
  card.className = "event-card event-card--fresh";
  card.textContent = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
  logElement.prepend(card);

  while (logElement.childElementCount > 16) {
    logElement.removeChild(logElement.lastElementChild);
  }
}

function setSummary(lines) {
  const summary = Array.isArray(lines) ? lines.join("\n") : String(lines);
  smokeState.summary = summary;
  summaryBox.textContent = summary;
  commitState();
}

function renderInfoTable(infoEntries) {
  infoBody.textContent = "";

  if (!infoEntries.length) {
    const row = document.createElement("tr");
    const fieldCell = document.createElement("td");
    fieldCell.textContent = "State";
    const valueCell = document.createElement("td");
    valueCell.textContent = "No probe data yet.";
    row.append(fieldCell, valueCell);
    infoBody.appendChild(row);
    return;
  }

  for (const entry of infoEntries) {
    const row = document.createElement("tr");
    const fieldCell = document.createElement("td");
    const valueCell = document.createElement("td");
    fieldCell.textContent = entry.label;
    valueCell.textContent = entry.value;
    row.append(fieldCell, valueCell);
    infoBody.appendChild(row);
  }
}

function formatHex16(value) {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function decodeAscii(bytes) {
  const zeroIndex = bytes.indexOf(0);
  const useful = zeroIndex === -1 ? bytes : bytes.slice(0, zeroIndex);
  return new TextDecoder("utf-8").decode(useful).trim() || "-";
}

function parseCapabilities(value) {
  const features = [];
  if (value & 0x01) {
    features.push("SWD");
  }
  if (value & 0x02) {
    features.push("JTAG");
  }
  if (value & 0x04) {
    features.push("SWO UART");
  }
  if (value & 0x08) {
    features.push("SWO Manchester");
  }
  if (value & 0x10) {
    features.push("Atomic");
  }
  if (value & 0x20) {
    features.push("Test Domain Timer");
  }
  return features.length ? `${features.join(", ")} (${formatHex16(value)})` : formatHex16(value);
}

function parseInfoValue(field, bytes) {
  if (field.format === "string") {
    return decodeAscii(bytes);
  }
  if (field.format === "u8") {
    return String(bytes[0] ?? 0);
  }
  if (field.format === "u16") {
    return String((bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8));
  }
  if (field.format === "capabilities") {
    return parseCapabilities(bytes[0] ?? 0);
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(" ");
}

function updateChips() {
  probeDeviceChip.textContent = smokeState.selectedDevice || "No probe selected";
  probeInterfaceChip.textContent = smokeState.interfaceLabel || "No interface claimed";
  probePacketChip.textContent = smokeState.packetSize ? `Packet size: ${smokeState.packetSize} bytes` : "Packet size: -";
}

function matchesExpectedDevice(device) {
  return (
    (device.vendorId === 0x2886 && device.productId === 0x0066) ||
    /CMSIS-DAP/i.test(device.productName || "")
  );
}

function pickCmsisDapInterface(device) {
  const configuration = device.configuration;
  if (!configuration) {
    throw new Error("USB configuration was not selected.");
  }

  const interfaces = configuration.interfaces || [];
  for (const usbInterface of interfaces) {
    const alternates = usbInterface.alternates || (usbInterface.alternate ? [usbInterface.alternate] : []);
    for (const alternate of alternates) {
      const endpoints = alternate.endpoints || [];
      const outEndpoint = endpoints.find((endpoint) => endpoint.direction === "out" && endpoint.type === "bulk");
      const inEndpoint = endpoints.find((endpoint) => endpoint.direction === "in" && endpoint.type === "bulk");
      const interfaceName = alternate.interfaceName || usbInterface.interfaceName || "";
      if (!outEndpoint || !inEndpoint) {
        continue;
      }
      if (alternate.interfaceClass === 0xff || /CMSIS-DAP/i.test(interfaceName)) {
        return {
          interfaceNumber: usbInterface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          interfaceName: interfaceName || `Interface ${usbInterface.interfaceNumber}`,
          outEndpoint: outEndpoint.endpointNumber,
          inEndpoint: inEndpoint.endpointNumber,
          packetSize: Math.max(outEndpoint.packetSize || 64, inEndpoint.packetSize || 64),
        };
      }
    }
  }

  throw new Error("No CMSIS-DAP v2 bulk interface was found on the selected USB device.");
}

async function sendCommand(commandId, payload = []) {
  if (!session.device) {
    throw new Error("No USB device is open.");
  }

  const packet = new Uint8Array(session.packetSize);
  packet[0] = commandId;
  packet.set(payload, 1);

  const outResult = await session.device.transferOut(session.outEndpoint, packet);
  if (outResult.status !== "ok") {
    throw new Error(`transferOut failed with status ${outResult.status}`);
  }

  const inResult = await session.device.transferIn(session.inEndpoint, session.packetSize);
  if (inResult.status !== "ok" || !inResult.data) {
    throw new Error(`transferIn failed with status ${inResult.status}`);
  }

  const view = new Uint8Array(inResult.data.buffer, inResult.data.byteOffset, inResult.data.byteLength);
  if (view[0] !== commandId) {
    throw new Error(`Unexpected CMSIS-DAP response ${view[0] ?? "?"} for command ${commandId}`);
  }
  return view;
}

async function readInfo(field) {
  const response = await sendCommand(0x00, [field.id]);
  const length = response[1] ?? 0;
  return response.slice(2, 2 + length);
}

async function releaseProbe() {
  const device = session.device;
  if (!device) {
    return;
  }

  try {
    if (session.interfaceNumber !== null) {
      try {
        await device.releaseInterface(session.interfaceNumber);
      } catch (error) {
        appendLog("warn", `releaseInterface failed: ${error.message}`);
      }
    }
    if (device.opened) {
      await device.close();
    }
  } finally {
    session.device = null;
    session.interfaceNumber = null;
    session.outEndpoint = null;
    session.inEndpoint = null;
    session.packetSize = 64;
  }
}

async function runSmokeTest(device) {
  requestButton.disabled = true;
  authorizedButton.disabled = true;
  disconnectButton.disabled = true;
  logElement.textContent = "";
  renderInfoTable([]);

  smokeState.ok = false;
  smokeState.error = "";
  smokeState.logs = [];
  smokeState.info = {};
  smokeState.selectedDevice = `${device.productName || "Unknown USB Device"} (${formatHex16(device.vendorId)}:${formatHex16(device.productId)})`;
  smokeState.usbId = `${formatHex16(device.vendorId)}:${formatHex16(device.productId)}`;
  smokeState.interfaceLabel = "";
  smokeState.outEndpoint = null;
  smokeState.inEndpoint = null;
  smokeState.packetSize = 64;
  smokeState.dapPort = "";
  updateChips();

  setPhase("opening");
  setBadge("connecting", "Opening");
  setSummary("Opening the selected USB device.");
  appendLog("info", `Selected ${smokeState.selectedDevice}`);

  try {
    await device.open();
    appendLog("info", "USB device opened.");

    if (!device.configuration) {
      await device.selectConfiguration(1);
      appendLog("info", "USB configuration 1 selected.");
    }

    const cmsisDap = pickCmsisDapInterface(device);
    session.device = device;
    session.interfaceNumber = cmsisDap.interfaceNumber;
    session.outEndpoint = cmsisDap.outEndpoint;
    session.inEndpoint = cmsisDap.inEndpoint;
    session.packetSize = cmsisDap.packetSize;
    session.deviceLabel = smokeState.selectedDevice;
    session.interfaceLabel = `${cmsisDap.interfaceName} (#${cmsisDap.interfaceNumber})`;
    smokeState.outEndpoint = session.outEndpoint;
    smokeState.inEndpoint = session.inEndpoint;

    if (cmsisDap.alternateSetting !== device.configuration.interfaces[cmsisDap.interfaceNumber]?.alternate?.alternateSetting) {
      try {
        await device.selectAlternateInterface(cmsisDap.interfaceNumber, cmsisDap.alternateSetting);
      } catch (error) {
        appendLog("warn", `selectAlternateInterface was skipped: ${error.message}`);
      }
    }

    await device.claimInterface(cmsisDap.interfaceNumber);
    appendLog("info", `Claimed ${session.interfaceLabel}.`);

    smokeState.interfaceLabel = session.interfaceLabel;
    smokeState.packetSize = session.packetSize;
    updateChips();
    setPhase("reading_info");
    setSummary([
      `Probe: ${smokeState.selectedDevice}`,
      `Interface: ${session.interfaceLabel}`,
      `Endpoints: OUT ${session.outEndpoint} / IN ${session.inEndpoint}`,
      `Packet size: ${session.packetSize} bytes`,
      "",
      "Reading CMSIS-DAP info.",
    ]);

    const infoEntries = [];
    for (const field of INFO_FIELDS) {
      const bytes = await readInfo(field);
      const value = parseInfoValue(field, bytes);
      smokeState.info[field.key] = value;
      infoEntries.push({ label: field.label, value });
      if (field.key === "packetSize") {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) {
          session.packetSize = parsed;
          smokeState.packetSize = parsed;
          updateChips();
        }
      }
    }
    renderInfoTable(infoEntries);
    appendLog("info", "CMSIS-DAP info read completed.");

    setPhase("dap_connect");
    const connectResponse = await sendCommand(0x02, [0x01]);
    const selectedPort = connectResponse[1] ?? 0;
    if (selectedPort !== 0x01) {
      throw new Error(`DAP_Connect returned port ${selectedPort}, expected SWD (1).`);
    }
    smokeState.dapPort = "SWD";
    appendLog("info", "DAP_Connect selected SWD transport.");

    const disconnectResponse = await sendCommand(0x03, []);
    if ((disconnectResponse[1] ?? 0) !== 0x00) {
      appendLog("warn", `DAP_Disconnect returned ${disconnectResponse[1] ?? 0}.`);
    } else {
      appendLog("info", "DAP_Disconnect completed cleanly.");
    }

    await releaseProbe();
    appendLog("info", "Probe released.");

    smokeState.ok = true;
    setPhase("done");
    setBadge("live", "Passed");
    setSummary([
      `Probe: ${smokeState.selectedDevice}`,
      `Interface: ${smokeState.interfaceLabel}`,
      `Endpoints: OUT ${smokeState.outEndpoint ?? "-"} / IN ${smokeState.inEndpoint ?? "-"}`,
      `Packet size: ${smokeState.packetSize} bytes`,
      `Vendor: ${smokeState.info.vendor || "-"}`,
      `Product: ${smokeState.info.product || "-"}`,
      `Serial: ${smokeState.info.serial || "-"}`,
      `Firmware: ${smokeState.info.firmware || "-"}`,
      `DAP transport: ${smokeState.dapPort || "-"}`,
      "",
      "Smoke test passed. The WebUSB session has been released.",
    ]);
  } catch (error) {
    smokeState.error = error.message || String(error);
    setPhase("error");
    setBadge("error", "Failed");
    appendLog("error", smokeState.error);
    setSummary([
      `Probe: ${smokeState.selectedDevice || "None"}`,
      `Interface: ${smokeState.interfaceLabel || "-"}`,
      `Packet size: ${smokeState.packetSize || "-"}`,
      "",
      `Error: ${smokeState.error}`,
    ]);
    renderInfoTable([]);
    await releaseProbe();
  } finally {
    requestButton.disabled = false;
    authorizedButton.disabled = false;
    disconnectButton.disabled = !session.device;
    updateChips();
  }
}

async function refreshAuthorizedCount() {
  if (!("usb" in navigator)) {
    authorizedCountValue.textContent = "N/A";
    return;
  }
  try {
    const devices = await navigator.usb.getDevices();
    authorizedCountValue.textContent = String(devices.length);
  } catch (error) {
    authorizedCountValue.textContent = "?";
    appendLog("warn", `getDevices failed: ${error.message}`);
  }
}

async function onRequestClick() {
  if (!("usb" in navigator)) {
    smokeState.error = "This browser does not expose navigator.usb.";
    setPhase("error");
    setBadge("error", "Unsupported");
    setSummary(smokeState.error);
    return;
  }

  setPhase("requesting");
  setBadge("connecting", "Requesting");
  setSummary("Waiting for the WebUSB chooser.");
  try {
    const device = await navigator.usb.requestDevice({ filters: FILTERS });
    await runSmokeTest(device);
    await refreshAuthorizedCount();
  } catch (error) {
    smokeState.ok = false;
    smokeState.error = error.message || String(error);
    if (error && error.name === "NotFoundError") {
      setSummary("No USB device was selected.");
      appendLog("warn", "The WebUSB chooser was dismissed without selecting a device.");
      setBadge("connecting", "Ready");
      setPhase("ready");
    } else {
      setPhase("error");
      setBadge("error", "Failed");
      appendLog("error", smokeState.error);
      setSummary(smokeState.error);
    }
  }
}

async function onAuthorizedClick() {
  if (!("usb" in navigator)) {
    smokeState.error = "This browser does not expose navigator.usb.";
    setPhase("error");
    setBadge("error", "Unsupported");
    setSummary(smokeState.error);
    return;
  }

  setPhase("checking_authorized");
  setBadge("connecting", "Checking");
  setSummary("Looking for an already authorized CMSIS-DAP probe.");

  try {
    const devices = await navigator.usb.getDevices();
    const device = devices.find(matchesExpectedDevice);
    if (!device) {
      throw new Error("No authorized CMSIS-DAP probe was found. Run the chooser flow once to grant access.");
    }
    await runSmokeTest(device);
    await refreshAuthorizedCount();
  } catch (error) {
    smokeState.ok = false;
    smokeState.error = error.message || String(error);
    setPhase("error");
    setBadge("error", "Failed");
    appendLog("error", smokeState.error);
    setSummary(smokeState.error);
  }
}

async function onDisconnectClick() {
  await releaseProbe();
  disconnectButton.disabled = true;
  appendLog("info", "Release button completed.");
}

window.disconnectProbe = onDisconnectClick;

requestButton.addEventListener("click", () => {
  void onRequestClick();
});

authorizedButton.addEventListener("click", () => {
  void onAuthorizedClick();
});

disconnectButton.addEventListener("click", () => {
  void onDisconnectClick();
});

window.runAuthorizedProbe = onAuthorizedClick;

if ("usb" in navigator) {
  usbSupportValue.textContent = "Available";
  setBadge("connecting", "Ready");
  setPhase("ready");
  setSummary("Ready to request a CMSIS-DAP WebUSB device.");
  void refreshAuthorizedCount();

  navigator.usb.addEventListener("disconnect", (event) => {
    appendLog("warn", `USB disconnect detected for ${event.device.productName || "device"}.`);
    if (session.device && event.device === session.device) {
      void releaseProbe();
      disconnectButton.disabled = true;
    }
  });
} else {
  usbSupportValue.textContent = "Unavailable";
  setBadge("error", "Unsupported");
  setPhase("error", { error: "navigator.usb is not available in this browser." });
  setSummary(smokeState.error);
}
