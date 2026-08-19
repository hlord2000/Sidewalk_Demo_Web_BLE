/* ==========================================================================
   admin.js — the admin Messages tab. Every message from every device, newest
   first, polled from /api/admin/messages. Polling (rather than the dashboard's
   SSE feed) keeps raw BLE shell chatter out of the customer event stream and
   survives a server restart, since the rows come from the database.
   ========================================================================== */
(function () {
  "use strict";

  const panel = document.querySelector('[data-tab-panel="messages"]');
  if (!panel) {
    return;
  }

  const tbody = document.getElementById("admin-message-rows");
  const empty = document.getElementById("admin-message-empty");
  const status = document.getElementById("admin-message-status");
  const count = document.getElementById("admin-message-count");
  const deviceFilter = document.getElementById("admin-message-device");
  const sourceFilter = document.getElementById("admin-message-source");
  const refreshButton = document.getElementById("admin-message-refresh");

  const POLL_MS = 3000;
  const PAGE_LIMIT = 200;
  const MAX_ROWS = 500;

  let newestId = 0;
  let pollTimer = null;
  let inFlight = false;
  let active = false;

  function query(params) {
    const search = new URLSearchParams(params);
    const device = deviceFilter ? deviceFilter.value : "";
    const source = sourceFilter ? sourceFilter.value : "";
    if (device) {
      search.set("device", device);
    }
    if (source) {
      search.set("source", source);
    }
    return search.toString();
  }

  function setStatus(text) {
    if (status) {
      status.textContent = text;
    }
  }

  function updateCount() {
    if (count) {
      count.textContent = String(tbody ? tbody.children.length : 0);
    }
    if (empty) {
      empty.hidden = Boolean(tbody && tbody.children.length);
    }
  }

  function shortTime(ts) {
    if (!ts) {
      return "";
    }
    const parsed = new Date(ts);
    if (Number.isNaN(parsed.getTime())) {
      return ts;
    }
    return parsed.toLocaleTimeString([], { hour12: false });
  }

  function shortDate(ts) {
    const parsed = new Date(ts);
    if (Number.isNaN(parsed.getTime())) {
      return "";
    }
    return parsed.toLocaleDateString();
  }

  function messageBody(message) {
    const parts = [];
    if (message.payload_text) {
      parts.push(message.payload_text);
    }
    if (message.payload_json) {
      parts.push(JSON.stringify(message.payload_json));
    }
    if (!parts.length && message.detail) {
      parts.push(message.detail);
    }
    if (message.payload_hex) {
      parts.push(`hex ${message.payload_hex}`);
    }
    if (!parts.length) {
      parts.push(message.detail || "—");
    }
    return parts.join(" · ");
  }

  function buildRow(message) {
    const row = document.createElement("tr");

    const when = document.createElement("td");
    when.className = "msg-when";
    const time = document.createElement("strong");
    time.textContent = shortTime(message.ts);
    const date = document.createElement("span");
    date.className = "muted";
    date.textContent = shortDate(message.ts);
    when.append(time, document.createElement("br"), date);

    const device = document.createElement("td");
    const deviceName = document.createElement("strong");
    if (message.device_name) {
      deviceName.textContent = message.device_name;
    } else {
      deviceName.textContent = message.ble_name || "Unidentified board";
      deviceName.className = "muted";
    }
    device.append(deviceName);
    if (message.wireless_device_id) {
      const id = document.createElement("code");
      id.textContent = message.wireless_device_id;
      device.append(document.createElement("br"), id);
    } else {
      const id = document.createElement("span");
      id.className = "muted";
      id.textContent = "no device ID — unverified BLE session";
      device.append(document.createElement("br"), id);
    }

    const source = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = message.source === "ble" ? "pill" : "pill pill--muted";
    pill.textContent = message.source === "ble" ? "BLE" : "Sidewalk";
    source.append(pill);
    if (message.link_name) {
      const link = document.createElement("span");
      link.className = "muted";
      link.textContent = message.link_name;
      source.append(document.createElement("br"), link);
    }

    const kind = document.createElement("td");
    kind.textContent = message.event_type;

    const body = document.createElement("td");
    body.className = "msg-body";
    const text = document.createElement("code");
    text.textContent = messageBody(message);
    body.append(text);

    row.append(when, device, source, kind, body);
    return row;
  }

  function trimRows() {
    if (!tbody) {
      return;
    }
    while (tbody.children.length > MAX_ROWS) {
      tbody.lastElementChild.remove();
    }
  }

  async function load({ reset = false } = {}) {
    if (!tbody || inFlight) {
      return;
    }
    inFlight = true;
    try {
      if (reset) {
        newestId = 0;
        tbody.replaceChildren();
      }
      const params = reset || !newestId
        ? { limit: String(PAGE_LIMIT) }
        : { limit: String(PAGE_LIMIT), after: String(newestId) };
      const response = await fetch(`/api/admin/messages?${query(params)}`, {
        headers: { Accept: "application/json" },
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        setStatus(result.error || "Could not load messages");
        return;
      }

      // The API returns newest-first; insert in reverse so the newest ends up on top.
      const messages = result.messages || [];
      for (const message of messages.slice().reverse()) {
        tbody.prepend(buildRow(message));
        newestId = Math.max(newestId, Number(message.id) || 0);
      }
      trimRows();
      updateCount();
      setStatus(`Updated ${new Date().toLocaleTimeString([], { hour12: false })}`);
    } catch (error) {
      setStatus(`Load error: ${error && error.message ? error.message : error}`);
    } finally {
      inFlight = false;
    }
  }

  function startPolling() {
    if (pollTimer) {
      return;
    }
    pollTimer = window.setInterval(() => {
      if (active && !document.hidden) {
        load();
      }
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  document.addEventListener("tab:activated", (event) => {
    const detail = event.detail || {};
    if (detail.tabset !== "admin") {
      return;
    }
    active = detail.target === "messages";
    if (active) {
      load({ reset: !newestId });
      startPolling();
    } else {
      stopPolling();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (active && !document.hidden) {
      load();
    }
  });

  for (const filter of [deviceFilter, sourceFilter]) {
    if (filter) {
      filter.addEventListener("change", () => load({ reset: true }));
    }
  }

  if (refreshButton) {
    refreshButton.addEventListener("click", () => load({ reset: true }));
  }

  // The tab controller fires tab:activated on load, which covers a deep link
  // straight to #messages; this only matters if that already happened.
  if (!panel.hidden) {
    active = true;
    load({ reset: true });
    startPolling();
  }
})();
