/* ==========================================================================
   provisioning.js: guided BLE provisioning wizard.

   Zero dependencies, no build step, matching the rest of this app. Writes no
   Web Bluetooth code of its own: app.js exposes its existing connect/send
   functions via init(opts) and this module drives them. Device response
   frames (EVT:{"t":"prov"|"provwr"|"provdone",...}) arrive through app.js's
   existing characteristicvaluechanged -> handleDeviceEvent pipeline, which
   forwards every event object here via ingestEvent().

   Steps: device (pick which AWS device's credentials to write) -> connect
   (BLE + read the board's own prov status) -> write (send the script,
   track provwr progress) -> verify (expect the reboot disconnect, reconnect,
   confirm provisioned:true).
   ========================================================================== */
(function () {
  "use strict";

  const PROV_SET_ACK_TIMEOUT_MS = 6000;
  const PROV_FINALIZE_TIMEOUT_MS = 12000;
  const PROV_STATUS_TIMEOUT_MS = 6000;
  // Generous: the first boot after provisioning runs a key migration before
  // the board answers anything again.
  const PROV_REBOOT_VERIFY_TIMEOUT_MS = 25000;
  const ERASE_SETTLE_MS = 400;
  const STEP_ORDER = ["device", "connect", "write", "verify"];

  let hooks = null;
  const els = {};

  let step = "device";
  let busy = false;
  let device = null;
  let connected = false;
  let detectedProv = null;
  let overwriteConfirmed = false;
  let rebootSent = false;
  let writeProgress = { done: 0, total: 0 };
  let pendingWait = null;

  function isDemo() {
    try {
      return new URLSearchParams(window.location.search).get("demo") === "1";
    } catch (err) {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function deviceList() {
    return (window.DEMO_CONFIG && window.DEMO_CONFIG.devices) || [];
  }

  function findDevice(id) {
    return deviceList().find((entry) => String(entry.id) === String(id)) || null;
  }

  function normalizeSmsn(value) {
    return String(value || "").toUpperCase().replace(/[^0-9A-F]/g, "");
  }

  function hazardMismatch() {
    if (!detectedProv || !detectedProv.provisioned || !device) {
      return false;
    }
    const seen = normalizeSmsn(detectedProv.smsn);
    const expected = normalizeSmsn(device.sidewalkSmsn);
    return Boolean(seen && expected && seen !== expected);
  }

  // ---- Pending device-reply wait -------------------------------------------
  // Only one wait is ever outstanding: commands are sent sequentially and
  // each is awaited before the next is sent.
  function clearPendingWait(error) {
    if (!pendingWait) {
      return;
    }
    const waiter = pendingWait;
    pendingWait = null;
    window.clearTimeout(waiter.timer);
    waiter.reject(error || new Error("Cancelled"));
  }

  function waitForDeviceEvent(predicate, timeoutMs, timeoutMessage) {
    clearPendingWait(new Error("Superseded by a new wait"));
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (pendingWait && pendingWait.timer === timer) {
          pendingWait = null;
          reject(new Error(timeoutMessage));
        }
      }, timeoutMs);
      pendingWait = { predicate, resolve, reject, timer };
    });
  }

  function ingestEvent(event) {
    if (!event || typeof event !== "object") {
      return;
    }
    if (event.t !== "prov" && event.t !== "provwr" && event.t !== "provdone") {
      return;
    }
    if (pendingWait && pendingWait.predicate(event)) {
      const waiter = pendingWait;
      pendingWait = null;
      window.clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }

  function onBleDisconnected() {
    connected = false;
    if (step === "write" && !rebootSent) {
      clearPendingWait(new Error("BLE disconnected"));
      setWriteStatus(
        "BLE disconnected before finishing. Safe to retry from the start: finalize did not run, so the device still reports itself unprovisioned.",
        "error",
      );
      if (!isDemo() && device) {
        reportStatus("failed", "BLE disconnected before provisioning finished").catch(() => {});
      }
      busy = false;
    } else if (step === "verify") {
      setVerifyStatus("Disconnected as expected after reboot. Reconnect when ready.");
    } else if (step === "connect") {
      setConnectStatus("Disconnected.");
    }
    render();
  }

  async function detectProvisionStatus(timeoutMs) {
    detectedProv = null;
    await hooks.sendBleCommand("prov status");
    const event = await waitForDeviceEvent(
      (candidate) => candidate.t === "prov",
      timeoutMs,
      "The device did not answer prov status in time.",
    );
    detectedProv = event;
    return event;
  }

  // ---- Command script ------------------------------------------------------
  function parseCommand(command) {
    const tokens = command.split(" ");
    if (tokens[0] === "prov" && tokens[1] === "set") {
      return { kind: "set", valueId: Number(tokens[2]), totalLen: Number(tokens[3]) };
    }
    if (tokens[0] === "prov" && tokens[1] === "erase") {
      return { kind: "erase" };
    }
    if (tokens[0] === "prov" && tokens[1] === "finalize") {
      return { kind: "finalize" };
    }
    if (tokens[0] === "prov" && tokens[1] === "reboot") {
      return { kind: "reboot" };
    }
    return { kind: "unknown" };
  }

  function describeCommand(parsed) {
    switch (parsed.kind) {
      case "erase":
        return "prov erase";
      case "set":
        return `prov set ${parsed.valueId} (${parsed.totalLen} bytes)`;
      case "finalize":
        return "prov finalize";
      case "reboot":
        return "prov reboot";
      default:
        return "unknown command";
    }
  }

  async function fetchScript() {
    const response = await fetch(`/api/devices/${device.id}/provisioning-script`, {
      headers: { Accept: "application/json" },
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || !result.ok) {
      throw new Error((result && result.error) || "Could not fetch the provisioning script");
    }
    return result;
  }

  async function runRealScript(data) {
    const commands = data.commands || [];
    writeProgress = { done: 0, total: data.valueCount || 0 };
    updateProgress();

    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      const parsed = parseCommand(command);
      logWrite(`sent: ${describeCommand(parsed)}`);
      await hooks.sendBleCommand(command);

      if (parsed.kind === "erase") {
        await sleep(ERASE_SETTLE_MS);
        continue;
      }

      if (parsed.kind === "reboot") {
        rebootSent = true;
        continue;
      }

      if (parsed.kind === "set") {
        // A value can be split across several "prov set" fragments sharing
        // the same id; the firmware only writes the value (and reports
        // provwr) once the last fragment lands, so only wait there.
        const next = commands[index + 1] ? parseCommand(commands[index + 1]) : null;
        const moreFragmentsComing = next && next.kind === "set" && next.valueId === parsed.valueId;
        if (moreFragmentsComing) {
          continue;
        }
        const event = await waitForDeviceEvent(
          (candidate) => candidate.t === "provwr" && Number(candidate.id) === parsed.valueId,
          PROV_SET_ACK_TIMEOUT_MS,
          `Device did not confirm value ${parsed.valueId} in time`,
        );
        if (!event.ok) {
          throw new Error(`Device rejected value ${parsed.valueId}`);
        }
        writeProgress.done += 1;
        updateProgress();
        logWrite(`recv: value ${parsed.valueId} ok`);
        continue;
      }

      if (parsed.kind === "finalize") {
        const event = await waitForDeviceEvent(
          (candidate) => candidate.t === "provdone",
          PROV_FINALIZE_TIMEOUT_MS,
          "Device did not confirm finalize in time",
        );
        logWrite(`recv: finalize ${event.ok ? "ok" : "failed"}`);
        if (!event.ok) {
          throw new Error(event.err ? `Finalize failed: ${event.err}` : "Finalize failed");
        }
      }
    }
  }

  async function runDemoScript() {
    writeProgress = { done: 0, total: 35 };
    updateProgress();
    logWrite("sent: prov erase (demo)");
    await sleep(200);
    for (let id = 1; id <= 35; id += 1) {
      await sleep(35);
      writeProgress.done = id;
      updateProgress();
      logWrite(`recv: value ${id} ok (demo)`);
    }
    logWrite("sent: prov finalize (demo)");
    await sleep(300);
    logWrite("recv: finalize ok (demo)");
    logWrite("sent: prov reboot (demo)");
    rebootSent = true;
  }

  async function reportStatus(status, reason) {
    try {
      const response = await fetch(`/api/devices/${device.id}/provisioning-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, reason: reason || "" }),
      });
      const result = await response.json().catch(() => null);
      if (result && result.ok && result.device) {
        Object.assign(device, result.device);
      }
    } catch (error) {
      // Best-effort telemetry; must never block the wizard itself.
    }
  }

  // ---- Step actions ---------------------------------------------------------
  async function handleConnect() {
    if (busy) {
      return;
    }
    busy = true;
    render();
    setConnectStatus("Opening Bluetooth chooser...", "working");
    try {
      if (isDemo()) {
        await sleep(400);
        connected = true;
        await sleep(400);
        detectedProv = { t: "prov", provisioned: false, smsn: "", mfg_ver: 4294967295 };
      } else {
        hooks.activateDevice(device);
        await hooks.connectBleShell("provision-wizard", { anyDevice: true });
        hooks.setBleLogDeviceId(device.id);
        connected = true;
        setConnectStatus("Connected. Checking device state...", "working");
        await detectProvisionStatus(PROV_STATUS_TIMEOUT_MS);
      }
      setConnectStatus("Connected.", "success");
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setConnectStatus(`Connect failed: ${message}`, "error");
    } finally {
      busy = false;
      render();
    }
  }

  async function handleDisconnect() {
    if (busy) {
      return;
    }
    if (isDemo()) {
      connected = false;
      setConnectStatus("Disconnected (demo).");
      render();
      return;
    }
    busy = true;
    render();
    try {
      await hooks.disconnectBleShell();
    } finally {
      connected = false;
      busy = false;
      setConnectStatus("Disconnected.");
      render();
    }
  }

  async function startWrite() {
    if (busy) {
      return;
    }
    if (hazardMismatch() && !overwriteConfirmed) {
      return;
    }
    busy = true;
    clearWriteLog();
    writeProgress = { done: 0, total: 0 };
    rebootSent = false;
    setWriteStatus("Fetching provisioning script...", "working");
    render();
    try {
      if (!isDemo()) {
        await reportStatus("attempted", "");
      }
      if (isDemo()) {
        await runDemoScript();
      } else {
        const data = await fetchScript();
        await runRealScript(data);
      }
      setWriteStatus("Credentials written. Rebooting.", "success");
      detectedProv = null;
      step = "verify";
      if (!isDemo()) {
        await reportStatus("succeeded", "");
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setWriteStatus(
        `${message} Safe to retry from the start: finalize did not complete, so the device still reports itself unprovisioned.`,
        "error",
      );
      if (!isDemo()) {
        await reportStatus("failed", message).catch(() => {});
      }
    } finally {
      busy = false;
      render();
    }
  }

  async function handleReconnect() {
    if (busy) {
      return;
    }
    busy = true;
    setVerifyStatus("Opening Bluetooth chooser...", "working");
    render();
    try {
      if (isDemo()) {
        await sleep(500);
        connected = true;
        setVerifyStatus("Reconnected (demo).", "working");
        await sleep(600);
        detectedProv = {
          t: "prov",
          provisioned: true,
          smsn: (device && device.sidewalkSmsn) || "",
          mfg_ver: 9,
        };
      } else {
        hooks.activateDevice(device);
        await hooks.connectBleShell("provision-wizard-verify", { anyDevice: true });
        hooks.setBleLogDeviceId(device.id);
        connected = true;
        setVerifyStatus("Reconnected. Checking device state...", "working");
        await detectProvisionStatus(PROV_REBOOT_VERIFY_TIMEOUT_MS);
      }

      if (detectedProv.provisioned && !hazardMismatch()) {
        setVerifyStatus("Verified.", "success");
        if (!isDemo()) {
          await reportStatus("verified", `smsn=${detectedProv.smsn || ""}`);
        }
      } else if (detectedProv.provisioned) {
        setVerifyStatus("Provisioned, but the SMSN does not match the AWS device on file. Do not treat this as verified.", "error");
        if (!isDemo()) {
          await reportStatus("failed", "SMSN mismatch after reboot");
        }
      } else {
        setVerifyStatus("Still reports unprovisioned. Reboot may still be in progress; try reconnecting again.", "error");
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setVerifyStatus(
        `${message} The first boot after provisioning runs a key migration, which can take a moment; try again.`,
        "error",
      );
    } finally {
      busy = false;
      render();
    }
  }

  function restartWizard() {
    if (connected && !isDemo() && hooks.disconnectBleShell) {
      hooks.disconnectBleShell().catch(() => {});
    }
    step = "device";
    detectedProv = null;
    connected = false;
    overwriteConfirmed = false;
    rebootSent = false;
    writeProgress = { done: 0, total: 0 };
    clearWriteLog();
    setConnectStatus("");
    setWriteStatus("");
    setVerifyStatus("");
    render();
  }

  async function handleCertificateSubmit(event) {
    event.preventDefault();
    if (!device) {
      return;
    }
    const fileInput = document.getElementById("prov-certificate-file");
    const statusEl = document.getElementById("prov-certificate-status");
    const submitButton = document.getElementById("prov-certificate-submit");
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) {
      setStatusEl(statusEl, "Choose a file first.", "error");
      return;
    }
    if (submitButton) {
      submitButton.disabled = true;
    }
    setStatusEl(statusEl, "Uploading...", "working");
    try {
      const formData = new FormData();
      formData.append("certificate_json", file);
      const response = await fetch(`/admin/devices/${device.id}/certificate-json`, {
        method: "POST",
        body: formData,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || !result.ok) {
        throw new Error((result && result.error) || "Upload failed");
      }
      Object.assign(device, result.device);
      setStatusEl(statusEl, "Uploaded. Credentials are ready to write.", "success");
      renderDeviceStep();
      window.setTimeout(() => {
        const dialog = document.getElementById("modal-certificate-json");
        if (dialog) {
          dialog.close();
        }
      }, 900);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setStatusEl(statusEl, message, "error");
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  }

  // ---- Rendering --------------------------------------------------------
  function setStatusEl(el, text, state) {
    if (!el) {
      return;
    }
    el.textContent = text || "";
    if (state) {
      el.dataset.state = state;
    } else {
      delete el.dataset.state;
    }
  }

  function setConnectStatus(text, state) {
    setStatusEl(els.connectStatus, text, state);
  }

  function setWriteStatus(text, state) {
    setStatusEl(els.writeStatus, text, state);
  }

  function setVerifyStatus(text, state) {
    setStatusEl(els.verifyStatus, text, state);
  }

  function logWrite(text) {
    if (!els.writeLog) {
      return;
    }
    const line = document.createElement("div");
    line.className = "event-card";
    line.textContent = text;
    els.writeLog.append(line);
    els.writeLog.scrollTop = els.writeLog.scrollHeight;
  }

  function clearWriteLog() {
    if (els.writeLog) {
      els.writeLog.replaceChildren();
    }
  }

  function updateProgress() {
    render();
  }

  function appendKv(container, key, value) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    row.append(dt, dd);
    container.append(row);
  }

  function renderStepper() {
    if (!els.stepItems) {
      return;
    }
    const currentIndex = STEP_ORDER.indexOf(step);
    for (const item of els.stepItems) {
      const index = STEP_ORDER.indexOf(item.dataset.wizardStep);
      item.classList.toggle("wizard-step--active", index === currentIndex);
      item.classList.toggle("wizard-step--done", index < currentIndex);
    }
  }

  function renderDeviceStep() {
    if (els.deviceSelect && device) {
      els.deviceSelect.value = String(device.id);
    }
    if (!els.deviceSummary) {
      return;
    }
    els.deviceSummary.replaceChildren();
    if (!device) {
      if (els.deviceWarning) {
        els.deviceWarning.textContent = "No device selected.";
      }
      if (els.deviceNextButton) {
        els.deviceNextButton.disabled = true;
      }
      return;
    }
    appendKv(els.deviceSummary, "Name", device.name);
    appendKv(els.deviceSummary, "Wireless ID", device.wirelessDeviceId);
    appendKv(els.deviceSummary, "Credentials", device.hasProvisioningArtifacts ? "Available" : "Missing");
    if (device.provisioningStatus) {
      const when = device.provisioningStatusAt ? ` · ${device.provisioningStatusAt}` : "";
      appendKv(els.deviceSummary, "Last status", `${device.provisioningStatus}${when}`);
      if (device.provisioningStatusReason) {
        appendKv(els.deviceSummary, "Reason", device.provisioningStatusReason);
      }
    }
    if (els.deviceWarning) {
      els.deviceWarning.textContent = device.hasProvisioningArtifacts || isDemo()
        ? ""
        : "No AWS provisioning artifacts yet. Refresh the device from AWS, or upload a certificate.json export below.";
    }
    if (els.deviceNextButton) {
      // Demo mode never fires a real write, so it is not gated on real AWS
      // artifacts: that is what makes the wizard walkable without hardware.
      els.deviceNextButton.disabled = !isDemo() && !device.hasProvisioningArtifacts;
    }
  }

  function renderConnectStep() {
    if (els.connectButton) {
      els.connectButton.disabled = busy;
    }
    if (els.disconnectButton) {
      els.disconnectButton.disabled = busy || !connected;
    }
    if (els.connectNextButton) {
      els.connectNextButton.disabled = busy || !detectedProv;
    }
    if (!els.detectResult) {
      return;
    }
    if (!detectedProv) {
      els.detectResult.hidden = true;
      return;
    }
    els.detectResult.hidden = false;
    if (!detectedProv.provisioned) {
      els.detectResult.textContent = "Blank device. No Sidewalk credentials on the manufacturing page.";
    } else if (hazardMismatch()) {
      els.detectResult.textContent =
        `Already provisioned with a different SMSN (${detectedProv.smsn || "unknown"}). ` +
        `This does not match the AWS device selected (${device.sidewalkSmsn}). ` +
        "Overwriting is a real risk: confirm on the write step before continuing.";
    } else {
      els.detectResult.textContent =
        `Already provisioned with the SMSN on file for this device (${detectedProv.smsn || device.sidewalkSmsn}). ` +
        "Continuing will rewrite its credentials.";
    }
  }

  function renderWriteStep() {
    const hazard = hazardMismatch();
    if (els.overwriteWarning) {
      els.overwriteWarning.hidden = !hazard;
      if (hazard) {
        els.overwriteWarning.textContent =
          `This device already reports a different Sidewalk identity (${detectedProv.smsn}) ` +
          `than the AWS device selected (${device.sidewalkSmsn}). Writing will permanently replace it.`;
      }
    }
    if (els.overwriteConfirmRow) {
      els.overwriteConfirmRow.hidden = !hazard;
    }
    if (els.writeStartButton) {
      els.writeStartButton.disabled = busy || (hazard && !overwriteConfirmed);
    }
    if (els.progressWrap) {
      els.progressWrap.hidden = writeProgress.total === 0;
    }
    if (els.progressFill) {
      const pct = writeProgress.total ? Math.round((writeProgress.done / writeProgress.total) * 100) : 0;
      els.progressFill.style.width = `${pct}%`;
    }
    if (els.progressLabel) {
      els.progressLabel.textContent = writeProgress.total
        ? `${writeProgress.done} / ${writeProgress.total} values written`
        : "";
    }
  }

  function renderVerifyStep() {
    if (els.reconnectButton) {
      els.reconnectButton.disabled = busy;
    }
    if (!els.verifyResult) {
      return;
    }
    if (step !== "verify" || !detectedProv) {
      els.verifyResult.hidden = true;
      return;
    }
    els.verifyResult.hidden = false;
    if (detectedProv.provisioned && !hazardMismatch()) {
      els.verifyResult.textContent =
        `Provisioned. SMSN ${detectedProv.smsn}. Cross-check this against the AWS Sidewalk console.`;
    } else if (detectedProv.provisioned) {
      els.verifyResult.textContent =
        `Device reports provisioned, but the SMSN (${detectedProv.smsn}) does not match the AWS device on file ` +
        `(${device.sidewalkSmsn}). Do not treat this as verified.`;
    } else {
      els.verifyResult.textContent =
        "Device still reports itself unprovisioned. Reboot may not have completed, or finalize did not run. Safe to retry.";
    }
  }

  function render() {
    renderStepper();
    for (const panel of Object.values(els.panels)) {
      if (panel) {
        panel.hidden = true;
      }
    }
    if (els.panels[step]) {
      els.panels[step].hidden = false;
    }
    renderDeviceStep();
    renderConnectStep();
    renderWriteStep();
    renderVerifyStep();
  }

  function chooseDevice(id) {
    device = findDevice(id);
    detectedProv = null;
    connected = false;
    overwriteConfirmed = false;
    if (els.overwriteConfirm) {
      els.overwriteConfirm.checked = false;
    }
    render();
  }

  function init(hookOpts) {
    hooks = hookOpts || {};

    els.panels = {
      device: document.querySelector('[data-wizard-panel="device"]'),
      connect: document.querySelector('[data-wizard-panel="connect"]'),
      write: document.querySelector('[data-wizard-panel="write"]'),
      verify: document.querySelector('[data-wizard-panel="verify"]'),
    };
    if (!els.panels.device) {
      // Not rendered for this account (no permission, or no assigned device).
      return;
    }

    els.stepItems = Array.from(document.querySelectorAll("#prov-steps .wizard-step"));
    els.deviceSelect = document.getElementById("prov-device-select");
    els.deviceSummary = document.getElementById("prov-device-summary");
    els.deviceWarning = document.getElementById("prov-device-warning");
    els.deviceNextButton = document.getElementById("prov-step-device-next");
    els.connectButton = document.getElementById("prov-connect");
    els.disconnectButton = document.getElementById("prov-disconnect");
    els.connectStatus = document.getElementById("prov-connect-status");
    els.detectResult = document.getElementById("prov-detect-result");
    els.connectBackButton = document.getElementById("prov-step-connect-back");
    els.connectNextButton = document.getElementById("prov-step-connect-next");
    els.overwriteWarning = document.getElementById("prov-overwrite-warning");
    els.overwriteConfirmRow = document.getElementById("prov-overwrite-confirm-row");
    els.overwriteConfirm = document.getElementById("prov-overwrite-confirm");
    els.writeStartButton = document.getElementById("prov-write-start");
    els.progressWrap = document.getElementById("prov-progress-wrap");
    els.progressFill = document.getElementById("prov-progress-fill");
    els.progressLabel = document.getElementById("prov-progress-label");
    els.writeStatus = document.getElementById("prov-write-status");
    els.writeLog = document.getElementById("prov-write-log");
    els.writeBackButton = document.getElementById("prov-step-write-back");
    els.reconnectButton = document.getElementById("prov-reconnect");
    els.verifyStatus = document.getElementById("prov-verify-status");
    els.verifyResult = document.getElementById("prov-verify-result");
    els.verifyBackButton = document.getElementById("prov-step-verify-back");
    els.restartButton = document.getElementById("prov-restart");
    els.certForm = document.getElementById("prov-certificate-form");

    if (els.deviceSelect) {
      els.deviceSelect.addEventListener("change", () => chooseDevice(els.deviceSelect.value));
    }
    if (els.deviceNextButton) {
      els.deviceNextButton.addEventListener("click", () => {
        step = "connect";
        render();
      });
    }
    if (els.connectButton) {
      els.connectButton.addEventListener("click", () => {
        handleConnect();
      });
    }
    if (els.disconnectButton) {
      els.disconnectButton.addEventListener("click", () => {
        handleDisconnect();
      });
    }
    if (els.connectBackButton) {
      els.connectBackButton.addEventListener("click", () => {
        step = "device";
        render();
      });
    }
    if (els.connectNextButton) {
      els.connectNextButton.addEventListener("click", () => {
        step = "write";
        render();
      });
    }
    if (els.overwriteConfirm) {
      els.overwriteConfirm.addEventListener("change", () => {
        overwriteConfirmed = els.overwriteConfirm.checked;
        render();
      });
    }
    if (els.writeStartButton) {
      els.writeStartButton.addEventListener("click", () => {
        startWrite();
      });
    }
    if (els.writeBackButton) {
      els.writeBackButton.addEventListener("click", () => {
        step = "connect";
        render();
      });
    }
    if (els.reconnectButton) {
      els.reconnectButton.addEventListener("click", () => {
        handleReconnect();
      });
    }
    if (els.verifyBackButton) {
      els.verifyBackButton.addEventListener("click", () => {
        step = "write";
        render();
      });
    }
    if (els.restartButton) {
      els.restartButton.addEventListener("click", () => {
        restartWizard();
      });
    }
    if (els.certForm) {
      els.certForm.addEventListener("submit", (event) => {
        handleCertificateSubmit(event);
      });
    }

    // The dashboard-wide device selector lives on the Monitor tab, so pick
    // up whatever it points to whenever this tab becomes visible.
    document.addEventListener("tab:activated", (event) => {
      if (!event.detail || event.detail.target !== "provision" || !hooks.currentDevice) {
        return;
      }
      const active = hooks.currentDevice();
      if (active && (!device || String(device.id) !== String(active.id))) {
        chooseDevice(active.id);
      }
    });

    const initial = (hooks.currentDevice && hooks.currentDevice()) || deviceList()[0] || null;
    chooseDevice(initial ? initial.id : "");
  }

  window.SidewalkProvisioning = { init, ingestEvent, onBleDisconnected };
})();
