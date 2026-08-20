/* ==========================================================================
   health.js: Memfault device-health panel.

   Zero dependencies, no build step, matching the rest of this app. Reuses
   sensors.js's TimeSeriesChart for the one trend chart it draws.

   Two independent signals feed this panel:
   - GET /api/devices/<id>/memfault-health, polled while the tab is visible.
     Backend caveat (see memfault.py): the live Memfault read API response
     shape is unverified, so every field is treated as possibly absent.
   - Live activity: the SSE stream already open in app.js publishes
     "memfault_chunk" (a chunk was detected on an uplink) and
     "memfault_forwarded" (a chunk was POSTed to Memfault) events, forwarded
     here from renderEvent(). The firmware also reports a chunk send on the
     BLE NUS shell as EVT:{"t":"mflt",...}, forwarded here from
     handleDeviceEvent(). Neither needs a second connection.

   Forwarding (MEMFAULT_PROJECT_KEY) and reading health back
   (MEMFAULT_ORG_AUTH_TOKEN/ORG_SLUG/PROJECT_SLUG) are configured
   independently on the backend; the health endpoint always returns pipeline
   fields (forwardingEnabled, lastChunkAt, lastForwardOk/Error, deviceSerial)
   even when read-back is not configured. Only the "device health" card below
   depends on read-back being configured.
   ========================================================================== */
(function () {
  "use strict";

  const POLL_INTERVAL_MS = 20000;
  const DEMO_TICK_MS = 6000;
  const LIVE_WINDOW_MS = 120000;

  const PIPELINE_TILE_DEFS = [
    { id: "forwarding", label: "Forwarding" },
    { id: "serial", label: "Device serial" },
    { id: "forwarded", label: "Chunks forwarded (session)" },
    { id: "lastChunk", label: "Last chunk seen" },
    { id: "failures", label: "Forwarding failures" },
  ];

  const DEVICE_TILE_DEFS = [
    { id: "lastSeen", label: "Last seen" },
    { id: "firmware", label: "Firmware version" },
    { id: "hardware", label: "Hardware version" },
    { id: "reboots", label: "Recent reboots" },
    { id: "battery", label: "Battery", unit: "%" },
  ];

  let hooks = null;
  const els = {};
  let pipelineTiles = {};
  let deviceTiles = {};

  let deviceId = null;
  let lastHealth = null;
  let pollTimer = null;
  let demoTimer = null;
  let demoTick = 0;
  let active = false;

  const session = { forwardedCount: 0, lastChunkAt: null };

  function isDemo() {
    try {
      return new URLSearchParams(window.location.search).get("demo") === "1";
    } catch (err) {
      return false;
    }
  }

  // ---- Small DOM/format helpers --------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setStatusEl(node, text, state) {
    if (!node) return;
    node.textContent = text || "";
    if (state) {
      node.dataset.state = state;
    } else {
      delete node.dataset.state;
    }
  }

  function setBadge(node, text, state) {
    if (!node) return;
    node.textContent = text;
    node.classList.remove("live-badge--connecting", "live-badge--live", "live-badge--error");
    node.classList.add(`live-badge--${state}`);
  }

  function timeAgo(ms) {
    if (!ms || !isFinite(ms)) {
      return "—";
    }
    const deltaSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (deltaSec < 5) return "Just now";
    if (deltaSec < 60) return `${deltaSec}s ago`;
    if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m ago`;
    if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)}h ago`;
    return new Date(ms).toLocaleString([], { hour12: false });
  }

  function formatTimestamp(value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? String(value) : timeAgo(parsed);
  }

  // Firmware metric key is not yet returned by the live read API (see
  // memfault.py's _fetch_device_health), so this checks a couple of plausible
  // shapes defensively rather than assuming one. Guessed, not verified.
  function extractBatteryPct(health) {
    const candidates = [health.batterySocPct, health.battery_soc_pct];
    for (const raw of candidates) {
      if (typeof raw === "number" && isFinite(raw)) {
        return raw;
      }
    }
    return null;
  }

  function buildTiles(container, defs) {
    const nodes = {};
    container.replaceChildren();
    for (const def of defs) {
      const tile = el("div", "stat-tile");
      tile.appendChild(el("span", "stat-label", def.label));
      const row = el("div", "stat-value-row");
      const value = el("strong", "stat-value", "—");
      row.appendChild(value);
      if (def.unit) {
        row.appendChild(el("span", "stat-unit", def.unit));
      }
      tile.appendChild(row);
      container.appendChild(tile);
      nodes[def.id] = { tile, value };
    }
    return nodes;
  }

  function setTile(node, text, boolState) {
    if (!node) return;
    node.value.textContent = text;
    if (boolState) {
      node.tile.classList.toggle("stat-tile--on", !!boolState.on);
      node.tile.classList.toggle("stat-tile--off", !!boolState.off);
    } else {
      node.tile.classList.remove("stat-tile--on", "stat-tile--off");
    }
  }

  // ---- Battery trend chart (lazy: only built once a real sample exists) ---
  function ensureBatteryChart() {
    if (els.batteryChart || !els.trendWrap || !window.SidewalkSensors) {
      return;
    }
    const card = el("article", "chart-card");
    const head = el("div", "chart-card-head");
    const titles = el("div", "chart-card-titles");
    titles.appendChild(el("h3", null, "Battery state of charge"));
    head.appendChild(titles);
    const latest = el("span", "chart-latest", "—");
    head.appendChild(latest);
    card.appendChild(head);

    const wrap = el("div", "chart-canvas-wrap");
    const canvas = document.createElement("canvas");
    canvas.className = "chart-canvas";
    wrap.appendChild(canvas);
    card.appendChild(wrap);

    els.trendWrap.appendChild(card);
    els.batteryChartLatest = latest;
    els.batteryChart = new window.SidewalkSensors.TimeSeriesChart(canvas, {
      series: [{ key: "v", label: "SoC", color: "#2a8a57" }],
      unit: "%",
      decimals: 0,
      yMin: 0,
      yMax: 100,
    });
  }

  function pushBatterySample(t, pct) {
    ensureBatteryChart();
    if (!els.batteryChart) {
      return;
    }
    els.batteryChart.push(t, { v: pct });
    if (els.batteryChartLatest) {
      els.batteryChartLatest.textContent = `${Math.round(pct)} %`;
    }
    els.trendWrap.hidden = false;
  }

  // ---- Rendering ------------------------------------------------------------
  function renderPipeline() {
    if (!els.pipelineStats) {
      return;
    }
    const health = lastHealth; // null until the first fetch succeeds
    const chunkMs = session.lastChunkAt || (health && health.lastChunkAt ? Date.parse(health.lastChunkAt) : null);
    const chunkText = chunkMs && !Number.isNaN(chunkMs) ? timeAgo(chunkMs) : "No chunks yet";
    setTile(pipelineTiles.forwarded, String(session.forwardedCount));
    setTile(pipelineTiles.lastChunk, chunkText);

    if (!health) {
      // Never successfully fetched: say "unknown", not a confident answer.
      setTile(pipelineTiles.forwarding, "—");
      setTile(pipelineTiles.serial, "—");
      setTile(pipelineTiles.failures, "—");
      setBadge(els.pipelineBadge, "Checking", "connecting");
      return;
    }

    setTile(pipelineTiles.forwarding, health.forwardingEnabled ? "Enabled" : "Disabled", {
      on: health.forwardingEnabled === true,
      off: health.forwardingEnabled === false,
    });
    setTile(pipelineTiles.serial, health.deviceSerial || "—");

    const failing = health.lastForwardOk === false;
    setTile(pipelineTiles.failures, failing ? health.lastForwardError || "Forwarding failed" : "None", {
      on: health.lastForwardOk === true,
      off: failing,
    });

    let state = "connecting";
    let text = "Idle";
    if (failing) {
      state = "error";
      text = "Forwarding failing";
    } else if (chunkMs && !Number.isNaN(chunkMs) && Date.now() - chunkMs < LIVE_WINDOW_MS) {
      state = "live";
      text = "Live";
    }
    setBadge(els.pipelineBadge, text, state);
  }

  function showNotConfigured() {
    if (els.notConfigured) els.notConfigured.hidden = false;
    if (els.deviceError) els.deviceError.hidden = true;
    if (els.deviceStats) els.deviceStats.hidden = true;
    if (els.trendWrap) els.trendWrap.hidden = true;
    if (els.dashboardLink) els.dashboardLink.hidden = true;
  }

  function showDeviceError(message) {
    if (els.deviceError) {
      els.deviceError.hidden = false;
      els.deviceError.textContent = message;
    }
    if (els.notConfigured) els.notConfigured.hidden = true;
    if (els.deviceStats) els.deviceStats.hidden = true;
    if (els.trendWrap) els.trendWrap.hidden = true;
    if (els.dashboardLink) els.dashboardLink.hidden = true;
  }

  function showDeviceStats() {
    if (els.deviceStats) els.deviceStats.hidden = false;
    if (els.notConfigured) els.notConfigured.hidden = true;
    if (els.deviceError) els.deviceError.hidden = true;
  }

  function renderDeviceHealth() {
    if (!els.deviceStats) {
      return;
    }
    const health = lastHealth;
    if (!health) {
      return; // nothing fetched yet; leave the initial empty state showing
    }
    if (!health.configured) {
      showNotConfigured();
      return;
    }
    if (health.error) {
      showDeviceError(`Memfault reported an error reading this device: ${health.error}`);
      return;
    }

    showDeviceStats();
    setTile(deviceTiles.lastSeen, health.lastSeen ? formatTimestamp(health.lastSeen) : "—");
    setTile(deviceTiles.firmware, health.softwareVersion || "—");
    setTile(deviceTiles.hardware, health.hardwareVersion || "—");
    setTile(
      deviceTiles.reboots,
      typeof health.recentRebootCount === "number" ? String(health.recentRebootCount) : "—"
    );

    const batteryPct = extractBatteryPct(health);
    setTile(deviceTiles.battery, batteryPct != null ? String(Math.round(batteryPct)) : "—");
    if (batteryPct != null) {
      pushBatterySample(Date.now(), batteryPct);
    }

    if (els.dashboardLink) {
      if (health.dashboardUrl) {
        els.dashboardLink.replaceChildren();
        const link = document.createElement("a");
        link.href = health.dashboardUrl;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "Open this device in Memfault";
        els.dashboardLink.appendChild(link);
        els.dashboardLink.hidden = false;
      } else {
        els.dashboardLink.hidden = true;
      }
    }
  }

  function renderAll() {
    renderPipeline();
    renderDeviceHealth();
  }

  // ---- Health fetch -----------------------------------------------------
  async function fetchHealth() {
    if (!deviceId) {
      return;
    }
    try {
      const response = await fetch(`/api/devices/${deviceId}/memfault-health`, {
        headers: { Accept: "application/json" },
      });
      if (response.status === 403) {
        showDeviceError("Not authorized to view this device's Memfault health.");
        return;
      }
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || !result.ok) {
        showDeviceError((result && result.error) || `Could not load device health (HTTP ${response.status}).`);
        return;
      }
      lastHealth = result.health || {};
      renderAll();
    } catch (error) {
      showDeviceError(`Network error: ${error && error.message ? error.message : error}`);
    }
  }

  // ---- Admin diagnostics ---------------------------------------------------
  function renderChunksMessage(message) {
    if (els.chunksBody) {
      els.chunksBody.replaceChildren();
    }
    if (els.chunksEmpty) {
      els.chunksEmpty.hidden = false;
      els.chunksEmpty.textContent = message;
    }
    if (els.chunksCount) {
      els.chunksCount.textContent = "0 chunks";
    }
  }

  function buildChunkRow(chunk) {
    const row = document.createElement("tr");

    const received = document.createElement("td");
    received.textContent = chunk.received_at || "—";

    const device = document.createElement("td");
    const code = document.createElement("code");
    code.textContent = chunk.device_serial || chunk.wireless_device_id || "—";
    device.appendChild(code);

    const seq = document.createElement("td");
    seq.textContent = chunk.sequence != null ? String(chunk.sequence) : "—";

    const bytes = document.createElement("td");
    bytes.textContent = chunk.chunk_len != null ? String(chunk.chunk_len) : "—";

    const status = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = chunk.status === "sent" ? "pill" : "pill pill--muted";
    pill.textContent = chunk.status || "unknown";
    status.appendChild(pill);

    const attempts = document.createElement("td");
    attempts.textContent = chunk.attempts != null ? String(chunk.attempts) : "0";

    const lastError = document.createElement("td");
    lastError.textContent = chunk.last_error || "—";

    row.append(received, device, seq, bytes, status, attempts, lastError);
    return row;
  }

  function renderChunkRows(chunks) {
    if (!els.chunksBody) {
      return;
    }
    els.chunksBody.replaceChildren();
    for (const chunk of chunks) {
      els.chunksBody.appendChild(buildChunkRow(chunk));
    }
    if (els.chunksEmpty) {
      els.chunksEmpty.hidden = chunks.length > 0;
      els.chunksEmpty.textContent = "No chunks recorded yet.";
    }
    if (els.chunksCount) {
      els.chunksCount.textContent = `${chunks.length} chunk${chunks.length === 1 ? "" : "s"}`;
    }
  }

  async function fetchAdminChunks() {
    if (!els.chunksBody || isDemo()) {
      return;
    }
    try {
      const response = await fetch("/api/admin/memfault/chunks?limit=50", {
        headers: { Accept: "application/json" },
      });
      if (response.status === 403) {
        renderChunksMessage("Not authorized to view chunk diagnostics.");
        return;
      }
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || !result.ok) {
        renderChunksMessage((result && result.error) || `Could not load chunks (HTTP ${response.status}).`);
        return;
      }
      renderChunkRows(result.chunks || []);
    } catch (error) {
      renderChunksMessage(`Network error: ${error && error.message ? error.message : error}`);
    }
  }

  async function handleTestConnectivity() {
    if (!els.connectivityStatus) {
      return;
    }
    if (isDemo()) {
      setStatusEl(els.connectivityStatus, "Connectivity check passed (demo). HTTP 200.", "success");
      return;
    }
    if (els.testConnectivityButton) {
      els.testConnectivityButton.disabled = true;
    }
    setStatusEl(els.connectivityStatus, "Testing...", "working");
    try {
      const response = await fetch("/api/admin/memfault/test-connectivity", { method: "POST" });
      if (response.status === 403) {
        setStatusEl(els.connectivityStatus, "Not authorized to run this check.", "error");
        return;
      }
      const result = await response.json().catch(() => null);
      if (!result) {
        setStatusEl(els.connectivityStatus, `Could not parse response (HTTP ${response.status}).`, "error");
        return;
      }
      if (result.ok) {
        const status = result.statusCode ? ` HTTP ${result.statusCode}.` : "";
        setStatusEl(els.connectivityStatus, `Connectivity check passed.${status}`, "success");
      } else {
        const status = result.statusCode ? ` HTTP ${result.statusCode}.` : "";
        setStatusEl(els.connectivityStatus, `${result.error || "Connectivity check failed."}${status}`, "error");
      }
    } catch (error) {
      setStatusEl(els.connectivityStatus, `Network error: ${error && error.message ? error.message : error}`, "error");
    } finally {
      if (els.testConnectivityButton) {
        els.testConnectivityButton.disabled = false;
      }
    }
  }

  // ---- Demo mode: strictly local, never touches the network ---------------
  function demoChunkRows() {
    const now = new Date().toISOString();
    return [
      { id: 6, wireless_device_id: "demo-wid", device_serial: "DEMO0001SMSN", sequence: 41, chunk_len: 96, received_at: now, status: "sent", attempts: 1, last_error: null },
      { id: 5, wireless_device_id: "demo-wid", device_serial: "DEMO0001SMSN", sequence: 40, chunk_len: 64, received_at: now, status: "sent", attempts: 1, last_error: null },
      { id: 4, wireless_device_id: "demo-wid", device_serial: "DEMO0001SMSN", sequence: 39, chunk_len: 128, received_at: now, status: "failed", attempts: 8, last_error: "HTTP 401: invalid project key" },
      { id: 3, wireless_device_id: "demo-wid", device_serial: "DEMO0001SMSN", sequence: 38, chunk_len: 32, received_at: now, status: "sent", attempts: 1, last_error: null },
      { id: 2, wireless_device_id: "demo-wid", device_serial: "DEMO0001SMSN", sequence: 37, chunk_len: 96, received_at: now, status: "sent", attempts: 2, last_error: null },
      { id: 1, wireless_device_id: "demo-wid", device_serial: "DEMO0001SMSN", sequence: 36, chunk_len: 64, received_at: now, status: "sent", attempts: 1, last_error: null },
    ];
  }

  function applyDemoSnapshot() {
    const soc = Math.max(4, 91 - demoTick * 0.6);
    lastHealth = {
      configured: true,
      forwardingEnabled: true,
      deviceSerial: "DEMO0001SMSN",
      dashboardUrl: "https://app.memfault.com/organizations/demo-org/projects/demo-project/devices/DEMO0001SMSN/",
      lastChunkAt: new Date(session.lastChunkAt).toISOString(),
      lastForwardOk: true,
      lastForwardError: null,
      lastSeen: new Date().toISOString(),
      softwareVersion: "1.4.2",
      hardwareVersion: "nrf54l15dk-nrf54l15-cpuapp",
      recentRebootCount: 3,
      batterySocPct: soc,
    };
  }

  function startDemo() {
    if (demoTimer) {
      return;
    }
    session.forwardedCount = 12;
    session.lastChunkAt = Date.now();
    applyDemoSnapshot();
    renderAll();
    renderChunkRows(demoChunkRows());

    demoTimer = window.setInterval(() => {
      demoTick += 1;
      session.forwardedCount += 1;
      session.lastChunkAt = Date.now();
      applyDemoSnapshot();
      renderAll();
    }, DEMO_TICK_MS);
  }

  function stopDemo() {
    if (demoTimer) {
      window.clearInterval(demoTimer);
      demoTimer = null;
    }
  }

  // ---- Polling: only while the health tab is visible -----------------------
  function startPolling() {
    active = true;
    if (isDemo()) {
      startDemo();
      return;
    }
    if (!deviceId) {
      return;
    }
    fetchHealth().finally(() => {
      // Only reaches here if still on the tab; a "not configured" response
      // never gets a repeating timer, since polling it again cannot change
      // the answer without a server restart.
      if (active && !pollTimer && lastHealth && lastHealth.configured) {
        pollTimer = window.setInterval(fetchHealth, POLL_INTERVAL_MS);
      }
    });
    fetchAdminChunks();
  }

  function stopPolling() {
    active = false;
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    stopDemo();
  }

  function resetForNewDevice() {
    lastHealth = null;
    session.forwardedCount = 0;
    session.lastChunkAt = null;
    if (els.batteryChart) {
      els.batteryChart.reset();
    }
    if (els.trendWrap) {
      els.trendWrap.hidden = true;
    }
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    renderPipeline();
  }

  function syncDevice() {
    const picked = (hooks.currentDevice && hooks.currentDevice()) || null;
    const nextId = picked ? picked.id : (window.DEMO_CONFIG && window.DEMO_CONFIG.selectedDeviceId) || null;
    if (nextId && String(nextId) !== String(deviceId)) {
      deviceId = nextId;
      resetForNewDevice();
    } else if (!deviceId && nextId) {
      deviceId = nextId;
    }
  }

  // ---- Live event ingestion -------------------------------------------------
  // Called from app.js's handleDeviceEvent for every parsed EVT:{...} frame
  // off the connected BLE shell; only "mflt" ones matter here.
  function ingestBleEvent(event) {
    if (!event || event.t !== "mflt" || isDemo()) {
      return;
    }
    session.lastChunkAt = Date.now();
    renderPipeline();
  }

  // Called from app.js's renderEvent for every SSE message on the already
  // open /api/events stream; only the two Memfault event types matter here.
  function ingestStreamEvent(event) {
    if (!event || typeof event !== "object" || isDemo()) {
      return;
    }
    if (event.type === "memfault_chunk") {
      session.lastChunkAt = Date.now();
      renderPipeline();
    } else if (event.type === "memfault_forwarded") {
      session.forwardedCount += 1;
      session.lastChunkAt = Date.now();
      renderPipeline();
      if (active && els.chunksBody) {
        fetchAdminChunks();
      }
    }
  }

  function init(hookOpts) {
    hooks = hookOpts || {};

    els.root = document.querySelector('[data-tab-panel="health"]');
    els.pipelineStats = document.getElementById("health-pipeline-stats");
    if (!els.root || !els.pipelineStats) {
      // No device assigned to this account, so the panel body was not rendered.
      return;
    }

    els.pipelineBadge = document.getElementById("health-pipeline-badge");
    els.notConfigured = document.getElementById("health-not-configured");
    els.deviceError = document.getElementById("health-device-error");
    els.deviceStats = document.getElementById("health-device-stats");
    els.trendWrap = document.getElementById("health-trend");
    els.dashboardLink = document.getElementById("health-dashboard-link");
    els.testConnectivityButton = document.getElementById("health-test-connectivity");
    els.connectivityStatus = document.getElementById("health-connectivity-status");
    els.chunksRefreshButton = document.getElementById("health-chunks-refresh");
    els.chunksBody = document.getElementById("health-chunks-rows");
    els.chunksEmpty = document.getElementById("health-chunks-empty");
    els.chunksCount = document.getElementById("health-chunks-count");

    pipelineTiles = buildTiles(els.pipelineStats, PIPELINE_TILE_DEFS);
    if (els.deviceStats) {
      deviceTiles = buildTiles(els.deviceStats, DEVICE_TILE_DEFS);
    }

    if (els.testConnectivityButton) {
      els.testConnectivityButton.addEventListener("click", handleTestConnectivity);
    }
    if (els.chunksRefreshButton) {
      els.chunksRefreshButton.addEventListener("click", () => fetchAdminChunks());
    }

    document.addEventListener("tab:activated", (event) => {
      const detail = event.detail || {};
      if (detail.tabset !== "dashboard") {
        return;
      }
      if (detail.target !== "health") {
        stopPolling();
        return;
      }
      syncDevice();
      startPolling();
      if (els.batteryChart) {
        els.batteryChart.scheduleDraw();
      }
    });

    renderPipeline();

    // A deep link straight to #health can fire tab:activated before this
    // listener registers (same race admin.js's message stream handles).
    if (!els.root.hidden) {
      syncDevice();
      startPolling();
    }
  }

  window.SidewalkHealth = { init, ingestBleEvent, ingestStreamEvent };
})();
