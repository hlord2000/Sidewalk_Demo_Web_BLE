/* ==========================================================================
   admin.js — the admin Messages tab. Every message from every device, newest
   first: stored rows backfill the view, then /api/admin/stream delivers new ones
   live, so BLE shell lines appear as the board prints them. Rows carry the
   database id, which doubles as the cursor for backfilling after a reconnect.
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

  const PAGE_LIMIT = 200;
  const MAX_ROWS = 500;
  const ID_MEMORY = 2000;

  let newestId = 0;
  let eventStream = null;
  let backfilling = false;
  let active = false;
  // Ids already on screen, so a live row and a backfilled row cannot double up.
  let renderedIds = new Set();

  function selectedDevice() {
    return deviceFilter ? deviceFilter.value : "";
  }

  function selectedSource() {
    return sourceFilter ? sourceFilter.value : "";
  }

  function setStatus(text, state = "connecting") {
    if (!status) {
      return;
    }
    status.textContent = text;
    status.classList.remove("live-badge--connecting", "live-badge--live", "live-badge--error");
    status.classList.add(`live-badge--${state}`);
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
    return Number.isNaN(parsed.getTime()) ? ts : parsed.toLocaleTimeString([], { hour12: false });
  }

  function shortDate(ts) {
    const parsed = new Date(ts);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString();
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
    return parts.length ? parts.join(" · ") : "—";
  }

  function buildRow(message) {
    const row = document.createElement("tr");
    if (message.id) {
      row.dataset.messageId = String(message.id);
    }

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
    const identity = document.createElement(message.wireless_device_id ? "code" : "span");
    if (message.wireless_device_id) {
      identity.textContent = message.wireless_device_id;
    } else {
      identity.className = "muted";
      identity.textContent = "no device ID — unverified BLE session";
    }
    device.append(document.createElement("br"), identity);

    const link = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = message.source === "ble" ? "pill" : "pill pill--muted";
    pill.textContent = message.source === "ble" ? "BLE" : "Sidewalk";
    link.append(pill);
    if (message.link_name) {
      const linkName = document.createElement("span");
      linkName.className = "muted";
      linkName.textContent = message.link_name;
      link.append(document.createElement("br"), linkName);
    }

    const kind = document.createElement("td");
    kind.textContent = message.event_type || "";

    const body = document.createElement("td");
    body.className = "msg-body";
    const text = document.createElement("code");
    text.textContent = messageBody(message);
    body.append(text);

    row.append(when, device, link, kind, body);
    return row;
  }

  function forgetTrimmedIds() {
    if (renderedIds.size <= ID_MEMORY) {
      return;
    }
    renderedIds = new Set(
      Array.from(tbody.children)
        .map((row) => Number(row.dataset.messageId))
        .filter(Boolean)
    );
  }

  function matchesFilters(message) {
    const device = selectedDevice();
    const source = selectedSource();
    if (device && message.wireless_device_id !== device) {
      return false;
    }
    if (source && message.source !== source) {
      return false;
    }
    return true;
  }

  function renderRow(message, { fresh = false } = {}) {
    const id = Number(message.id) || 0;
    if (id && renderedIds.has(id)) {
      return false;
    }
    const row = buildRow(message);
    if (fresh) {
      row.classList.add("msg-row--fresh");
      window.setTimeout(() => row.classList.remove("msg-row--fresh"), 1200);
    }
    tbody.prepend(row);
    if (id) {
      renderedIds.add(id);
      newestId = Math.max(newestId, id);
    }
    while (tbody.children.length > MAX_ROWS) {
      tbody.lastElementChild.remove();
    }
    forgetTrimmedIds();
    return true;
  }

  async function backfill({ reset = false } = {}) {
    if (!tbody || backfilling) {
      return;
    }
    backfilling = true;
    try {
      if (reset) {
        newestId = 0;
        renderedIds = new Set();
        tbody.replaceChildren();
      }
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (newestId) {
        params.set("after", String(newestId));
      }
      if (selectedDevice()) {
        params.set("device", selectedDevice());
      }
      if (selectedSource()) {
        params.set("source", selectedSource());
      }

      const response = await fetch(`/api/admin/messages?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        setStatus(result.error || "Could not load messages", "error");
        return;
      }

      // The API returns newest-first; insert in reverse so the newest lands on top.
      for (const message of (result.messages || []).slice().reverse()) {
        renderRow(message);
      }
      updateCount();
    } catch (error) {
      setStatus(`Load error: ${error && error.message ? error.message : error}`, "error");
    } finally {
      backfilling = false;
    }
  }

  function openStream() {
    if (eventStream) {
      return;
    }
    setStatus("Connecting to the live feed…", "connecting");
    const stream = new EventSource("/api/admin/stream");
    eventStream = stream;

    stream.onopen = () => {
      setStatus("Live", "live");
      // Catch anything that landed while the connection was down.
      backfill();
    };

    stream.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (!matchesFilters(message)) {
        return;
      }
      if (renderRow(message, { fresh: true })) {
        updateCount();
      }
    };

    stream.onerror = () => {
      if (eventStream !== stream) {
        return;
      }
      // EventSource reconnects on its own; onopen backfills the gap.
      setStatus("Reconnecting to the live feed…", "connecting");
    };
  }

  function closeStream() {
    if (eventStream) {
      eventStream.close();
      eventStream = null;
    }
  }

  document.addEventListener("tab:activated", (event) => {
    const detail = event.detail || {};
    if (detail.tabset !== "admin") {
      return;
    }
    active = detail.target === "messages";
    if (active) {
      backfill({ reset: !newestId });
      openStream();
    } else {
      closeStream();
    }
  });

  for (const filter of [deviceFilter, sourceFilter]) {
    if (filter) {
      filter.addEventListener("change", () => backfill({ reset: true }));
    }
  }

  if (refreshButton) {
    refreshButton.addEventListener("click", () => backfill({ reset: true }));
  }

  // Covers a deep link straight to #messages, where the tab controller may have
  // fired tab:activated before this script registered its listener.
  if (!panel.hidden) {
    active = true;
    backfill({ reset: true });
    openStream();
  }
})();
