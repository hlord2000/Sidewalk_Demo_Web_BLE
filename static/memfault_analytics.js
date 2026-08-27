/* ==========================================================================
   memfault_analytics.js: parsed Memfault device data, shown on the Monitor
   tab directly above the Raw Uplink Log.

   Zero dependencies, no build step, matching the rest of this app.

   Single data source: GET /api/devices/<id>/memfault-health, polled while
   the Monitor tab is visible. That endpoint's "health" object mixes local
   pipeline state (forwardingEnabled, lastChunkAt, lastForwardOk/Error) with
   fields read live from Memfault's own API (lastSeen, firstSeen,
   softwareVersion, hardwareVersion, cohort, nickname, recentRebootCount).
   This panel only renders the latter group — the point of the panel is that
   it is not the AWS uplink path — plus deviceSerial for
   identification and linking out.

   Two non-error states are first-class: "configured: false" (no Memfault
   read credentials) and a live-fetch failure surfaced as health.error
   (including HTTP 403 from Memfault itself). Our own endpoint returning
   403/404/network-error is a third, handled the same way as health.js does
   it for its own fetch.
   ========================================================================== */
(function () {
  "use strict";

  const POLL_INTERVAL_MS = 20000;
  const QUICK_REFRESH_DEBOUNCE_MS = 1500;

  const TILE_DEFS = [
    { id: "serial", label: "Device serial" },
    { id: "nickname", label: "Nickname" },
    { id: "hardware", label: "Hardware version" },
    { id: "software", label: "Software version" },
    { id: "cohort", label: "Cohort" },
    { id: "firstSeen", label: "First seen" },
    { id: "lastSeen", label: "Last seen" },
    { id: "reboots", label: "Recent reboots" },
  ];

  let hooks = null;
  const els = {};
  let tiles = {};

  let deviceId = null;
  let lastHealth = null;
  let pollTimer = null;
  let demoTimer = null;
  let quickRefreshTimer = null;
  let active = false;

  function isDemo() {
    try {
      return new URLSearchParams(window.location.search).get("demo") === "1";
    } catch (err) {
      return false;
    }
  }

  // ---- Small DOM/format helpers, duplicated per-file by convention here ---
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
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

  // Same overflow bug health.js fixed for a 64-character Sidewalk SMSN: show
  // head and tail, keep the full value in a tooltip/data attribute.
  function shortenId(value, keep) {
    const head = keep || 8;
    if (typeof value !== "string" || value.length <= head * 2 + 1) return value;
    return `${value.slice(0, head)}…${value.slice(-head)}`;
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
      tile.appendChild(row);
      container.appendChild(tile);
      nodes[def.id] = { tile, value };
    }
    return nodes;
  }

  function setTile(node, text) {
    if (!node) return;
    node.value.textContent = text;
  }

  function setIdTile(node, value) {
    if (!node) return;
    if (!value) {
      setTile(node, "—");
      node.value.removeAttribute("title");
      node.value.removeAttribute("data-full");
      return;
    }
    setTile(node, shortenId(value));
    node.value.setAttribute("title", value);
    node.value.setAttribute("data-full", value);
  }

  function setBadge(node, text, state) {
    if (!node) return;
    node.textContent = text;
    node.classList.remove("live-badge--connecting", "live-badge--live", "live-badge--error");
    node.classList.add(`live-badge--${state}`);
  }

  // ---- Visibility state machine: exactly one of these four is shown ------
  function showOnly(which) {
    if (els.empty) els.empty.hidden = which !== "empty";
    if (els.notConfigured) els.notConfigured.hidden = which !== "notConfigured";
    if (els.error) els.error.hidden = which !== "error";
    if (els.stats) els.stats.hidden = which !== "stats";
  }

  function showError(message) {
    showOnly("error");
    if (els.error) els.error.textContent = message;
    setBadge(els.badge, "Error", "error");
  }

  // ---- Rendering ------------------------------------------------------------
  function renderAll() {
    const health = lastHealth;
    if (!health) {
      return; // nothing fetched yet; leave the current state showing
    }

    if (!health.configured) {
      showOnly("notConfigured");
      setBadge(els.badge, "Not configured", "connecting");
      return;
    }

    if (health.error) {
      showError(`Could not read this device from Memfault: ${health.error}`);
      return;
    }

    showOnly("stats");
    setBadge(els.badge, "Live", "live");

    setIdTile(tiles.serial, health.deviceSerial);
    setTile(tiles.nickname, health.nickname || "—");
    setTile(tiles.hardware, health.hardwareVersion || "—");
    setTile(tiles.software, health.softwareVersion || "—");
    setTile(tiles.cohort, health.cohort || "—");
    setTile(tiles.firstSeen, health.firstSeen ? formatTimestamp(health.firstSeen) : "—");
    setTile(tiles.lastSeen, health.lastSeen ? formatTimestamp(health.lastSeen) : "—");
    setTile(
      tiles.reboots,
      typeof health.recentRebootCount === "number" ? String(health.recentRebootCount) : "—"
    );

  }

  // ---- Health fetch -----------------------------------------------------
  async function fetchHealth() {
    if (!deviceId) {
      showOnly("empty");
      setBadge(els.badge, "No device", "connecting");
      return;
    }
    try {
      const response = await fetch(`/api/devices/${deviceId}/memfault-health`, {
        headers: { Accept: "application/json" },
      });
      if (response.status === 403) {
        showError("Not authorized to view this device's Memfault data.");
        return;
      }
      const result = await response.json().catch(() => null);
      if (!response.ok || !result || !result.ok) {
        showError((result && result.error) || `Could not load Memfault data (HTTP ${response.status}).`);
        return;
      }
      lastHealth = result.health || {};
      renderAll();
    } catch (error) {
      showError(`Network error: ${error && error.message ? error.message : error}`);
    }
  }

  // ---- Demo mode: strictly local, never touches the network ---------------
  function applyDemoSnapshot() {
    lastHealth = {
      configured: true,
      forwardingEnabled: true,
      deviceSerial: "DEMO0001SMSN",
      lastSeen: new Date().toISOString(),
      firstSeen: "2026-05-01T09:12:00Z",
      softwareVersion: null,
      hardwareVersion: "xiao_nrf54l15_cpuapp",
      cohort: "default",
      nickname: null,
      recentRebootCount: 2,
      lastChunkAt: new Date().toISOString(),
      lastForwardOk: true,
      lastForwardError: null,
    };
  }

  function startDemo() {
    if (demoTimer) {
      return;
    }
    applyDemoSnapshot();
    renderAll();
    demoTimer = window.setInterval(() => {
      applyDemoSnapshot();
      renderAll();
    }, POLL_INTERVAL_MS);
  }

  function stopDemo() {
    if (demoTimer) {
      window.clearInterval(demoTimer);
      demoTimer = null;
    }
  }

  // ---- Polling: only while the Monitor tab is visible -----------------------
  function startPolling() {
    active = true;
    if (isDemo()) {
      startDemo();
      return;
    }
    if (!deviceId) {
      showOnly("empty");
      setBadge(els.badge, "No device", "connecting");
      return;
    }
    setBadge(els.badge, "Checking", "connecting");
    fetchHealth().finally(() => {
      // A "not configured" response never gets a repeating timer: polling it
      // again cannot change the answer without a server restart.
      if (active && !pollTimer && lastHealth && lastHealth.configured) {
        pollTimer = window.setInterval(fetchHealth, POLL_INTERVAL_MS);
      }
    });
  }

  function stopPolling() {
    active = false;
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    if (quickRefreshTimer) {
      window.clearTimeout(quickRefreshTimer);
      quickRefreshTimer = null;
    }
    stopDemo();
  }

  function resetForNewDevice() {
    lastHealth = null;
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    showOnly("empty");
    setBadge(els.badge, "Checking", "connecting");
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
  // Called from app.js's renderEvent for every SSE message on the already
  // open /api/events stream. A fresh chunk or forward does not necessarily
  // mean Memfault's own API has caught up yet, so this just nudges an early
  // re-fetch instead of assuming the new values.
  function ingestStreamEvent(event) {
    if (!event || typeof event !== "object" || isDemo()) {
      return;
    }
    if (event.type !== "memfault_chunk" && event.type !== "memfault_forwarded") {
      return;
    }
    if (!active || !deviceId || quickRefreshTimer) {
      return;
    }
    quickRefreshTimer = window.setTimeout(() => {
      quickRefreshTimer = null;
      fetchHealth();
    }, QUICK_REFRESH_DEBOUNCE_MS);
  }

  // Ask the device to fault on purpose. The downlink goes out over Sidewalk, the
  // device's fault handler records why it rebooted, and the reboot event comes
  // back over Sidewalk on the next boot, so the whole round trip is observable
  // without touching the board.
  async function requestDiagnostic(command) {
    if (!deviceId) {
      setCrashStatus("Select a device first.", "error");
      return;
    }
    if (els.crashButton) els.crashButton.disabled = true;
    setCrashStatus("Sending crash request over Sidewalk\u2026", "working");
    try {
      const response = await fetch(`/api/devices/${deviceId}/memfault/diagnostic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: command || "hardfault" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        setCrashStatus(body.error || `Request failed (HTTP ${response.status}).`, "error");
        return;
      }
      setCrashStatus(
        `Sent ${body.command} (0x${body.payloadHex}). The device reboots, then reports the reason on its next drain.`,
        "success"
      );
    } catch (err) {
      setCrashStatus(`Request failed: ${err.message}`, "error");
    } finally {
      if (els.crashButton) els.crashButton.disabled = false;
    }
  }

  function setCrashStatus(text, state) {
    if (!els.crashStatus) return;
    els.crashStatus.textContent = text;
    if (state) {
      els.crashStatus.dataset.state = state;
    } else {
      delete els.crashStatus.dataset.state;
    }
  }

  function init(hookOpts) {
    hooks = hookOpts || {};

    els.badge = document.getElementById("memfault-status-badge");
    els.empty = document.getElementById("memfault-empty");
    els.notConfigured = document.getElementById("memfault-not-configured");
    els.error = document.getElementById("memfault-error");
    els.stats = document.getElementById("memfault-stats");

    if (!els.stats) {
      // Panel markup not present on this page.
      return;
    }

    tiles = buildTiles(els.stats, TILE_DEFS);

    els.crashButton = document.getElementById("memfault-crash-button");
    els.crashStatus = document.getElementById("memfault-crash-status");
    if (els.crashButton) {
      els.crashButton.addEventListener("click", () =>
        requestDiagnostic(els.crashButton.dataset.command)
      );
    }

    document.addEventListener("tab:activated", (event) => {
      const detail = event.detail || {};
      if (detail.tabset !== "dashboard") {
        return;
      }
      if (detail.target !== "monitor") {
        stopPolling();
        return;
      }
      syncDevice();
      startPolling();
    });

    // A deep link straight to #monitor (the default tab) can fire
    // tab:activated before this listener registers.
    const panel = document.querySelector('[data-tab-panel="monitor"]');
    if (panel && !panel.hidden) {
      syncDevice();
      startPolling();
    }
  }

  window.SidewalkMemfault = { init, ingestStreamEvent };
})();
