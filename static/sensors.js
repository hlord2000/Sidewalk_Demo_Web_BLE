/* ==========================================================================
   sensors.js — live sensor telemetry dashboard for the Sidewalk console.

   Zero dependencies (matches the vendored-asset philosophy of this app).
   Consumes the same uplink events rendered by app.js and turns them into
   time-stamped charts + at-a-glance stat tiles.

   Firmware message structure (see ../Sidewalk_Workspace):
   The sensor_monitoring app sends a compact JSON telemetry payload that the
   server decodes into event.payload_json. Fields (any may be null):
     t_mc      temperature      milli-°C        -> °C   (/1000)
     rh_mpc    relative humidity milli-percent  -> %    (/1000)
     ax_mms2   accel X          milli-m/s^2     -> m/s² (/1000)
     ay_mms2   accel Y          milli-m/s^2     -> m/s²
     az_mms2   accel Z          milli-m/s^2     -> m/s²
     bat_mv    battery voltage  millivolts      -> V    (/1000)
     ibat_ua   battery current  microamps       -> mA   (/1000)
     bat_pct   battery level    percent         -> %
     vbus      USB present      bool
     chg       charger status   int
     err       charger error    int
     wake      motion wake      bool
   The legacy binary sid_demo "action notification" (temperature TLV, tag 0x6)
   is decoded best-effort from event.payload_hex when no telemetry JSON exists.
   ========================================================================== */
(function () {
  "use strict";

  const COLORS = {
    ink: "#2b343b",
    inkSoft: "#5d6b73",
    inkMuted: "#8c98a1",
    line: "#e3e9eb",
    grid: "#eef2f3",
    accent: "#00a9ce",
    blue: "#0077c8",
    green: "#2a8a57",
    violet: "#7a5af0",
    amber: "#b8860b",
    warn: "#b54732",
  };

  // -------------------------------------------------------------------------
  // Time-series chart — DPR-aware canvas, auto-ranging, gap-aware multi-series.
  // -------------------------------------------------------------------------
  class TimeSeriesChart {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.series = opts.series; // [{ key, label, color }]
      this.unit = opts.unit || "";
      this.decimals = opts.decimals == null ? 1 : opts.decimals;
      this.yMinFixed = opts.yMin;
      this.yMaxFixed = opts.yMax;
      this.maxPoints = opts.maxPoints || 720;
      this.minSpanMs = opts.minSpanMs || 60_000;
      this.points = []; // [{ t: epochMs, values: { key: number } }]
      this._raf = 0;

      if (typeof ResizeObserver === "function") {
        this._ro = new ResizeObserver(() => this.scheduleDraw());
        this._ro.observe(canvas);
      }
    }

    push(t, values) {
      this.points.push({ t, values });
      if (this.points.length > this.maxPoints) {
        this.points.shift();
      }
      this.scheduleDraw();
    }

    reset() {
      this.points = [];
      this.scheduleDraw();
    }

    latest() {
      for (let i = this.points.length - 1; i >= 0; i--) {
        return this.points[i];
      }
      return null;
    }

    scheduleDraw() {
      if (this._raf) {
        return;
      }
      this._raf = window.requestAnimationFrame(() => {
        this._raf = 0;
        this.draw();
      });
    }

    draw() {
      const ctx = this.ctx;
      const cssW = this.canvas.clientWidth;
      const cssH = this.canvas.clientHeight;
      if (cssW <= 0 || cssH <= 0) {
        return; // hidden (e.g. inactive tab); ResizeObserver redraws when shown
      }

      const dpr = window.devicePixelRatio || 1;
      const pxW = Math.round(cssW * dpr);
      const pxH = Math.round(cssH * dpr);
      if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
        this.canvas.width = pxW;
        this.canvas.height = pxH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const padL = 40;
      const padR = 12;
      const padT = 12;
      const padB = 22;
      const plotW = cssW - padL - padR;
      const plotH = cssH - padT - padB;

      ctx.font = "11px 'GT-Eesti-Regular', 'Noto Sans', Arial, sans-serif";
      ctx.textBaseline = "middle";

      if (this.points.length === 0) {
        ctx.fillStyle = COLORS.inkMuted;
        ctx.textAlign = "center";
        ctx.fillText("Awaiting telemetry…", padL + plotW / 2, padT + plotH / 2);
        this._drawFrame(ctx, padL, padT, plotW, plotH);
        return;
      }

      // X range — right-align the latest sample.
      const tMax = this.points[this.points.length - 1].t;
      const firstT = this.points[0].t;
      const tMin = Math.min(firstT, tMax - this.minSpanMs);
      const tSpan = Math.max(1, tMax - tMin);

      // Y range across every present value.
      let yMin = this.yMinFixed;
      let yMax = this.yMaxFixed;
      if (yMin == null || yMax == null) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const point of this.points) {
          for (const s of this.series) {
            const v = point.values[s.key];
            if (typeof v === "number" && isFinite(v)) {
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
          }
        }
        if (!isFinite(lo) || !isFinite(hi)) {
          lo = 0;
          hi = 1;
        }
        if (lo === hi) {
          const bump = Math.abs(lo) > 1 ? Math.abs(lo) * 0.05 : 0.5;
          lo -= bump;
          hi += bump;
        } else {
          const pad = (hi - lo) * 0.12;
          lo -= pad;
          hi += pad;
        }
        if (yMin == null) yMin = lo;
        if (yMax == null) yMax = hi;
      }
      const ySpan = Math.max(1e-6, yMax - yMin);

      const xAt = (t) => padL + ((t - tMin) / tSpan) * plotW;
      const yAt = (v) => padT + plotH - ((v - yMin) / ySpan) * plotH;

      // Horizontal gridlines + Y labels.
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = COLORS.inkMuted;
      ctx.textAlign = "right";
      const rows = 4;
      for (let i = 0; i <= rows; i++) {
        const v = yMin + (ySpan * i) / rows;
        const y = Math.round(yAt(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.fillText(this._fmt(v), padL - 6, y);
      }

      // X time labels (start / mid / end).
      ctx.textAlign = "center";
      const labelTimes = [tMin, tMin + tSpan / 2, tMax];
      labelTimes.forEach((t, idx) => {
        const x = xAt(t);
        ctx.textAlign = idx === 0 ? "left" : idx === labelTimes.length - 1 ? "right" : "center";
        const anchor = idx === 0 ? padL : idx === labelTimes.length - 1 ? padL + plotW : x;
        ctx.fillText(fmtTime(t), anchor, padT + plotH + 11);
      });

      // Series lines + points.
      for (const s of this.series) {
        const pts = [];
        for (const point of this.points) {
          const v = point.values[s.key];
          if (typeof v === "number" && isFinite(v)) {
            pts.push({ x: xAt(point.t), y: yAt(v) });
          }
        }
        if (!pts.length) {
          continue;
        }

        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();

        // Soft fill under single-series charts.
        if (this.series.length === 1) {
          const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
          grad.addColorStop(0, hexA(s.color, 0.16));
          grad.addColorStop(1, hexA(s.color, 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
          ctx.lineTo(pts[pts.length - 1].x, padT + plotH);
          ctx.lineTo(pts[0].x, padT + plotH);
          ctx.closePath();
          ctx.fill();
        }

        ctx.fillStyle = s.color;
        for (const p of pts) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
        // Emphasise the most recent reading.
        const last = pts[pts.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      this._drawFrame(ctx, padL, padT, plotW, plotH);
    }

    _drawFrame(ctx, x, y, w, h) {
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }

    _fmt(v) {
      const abs = Math.abs(v);
      const decimals = abs >= 100 ? 0 : this.decimals;
      return v.toFixed(decimals);
    }
  }

  // -------------------------------------------------------------------------
  // Sample extraction
  // -------------------------------------------------------------------------
  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  }

  function parseTs(event) {
    if (event && event.ts) {
      const parsed = Date.parse(event.ts);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return Date.now();
  }

  const TELEMETRY_KEYS = [
    "t_mc",
    "rh_mpc",
    "ax_mms2",
    "ay_mms2",
    "az_mms2",
    "bat_mv",
    "ibat_ua",
    "bat_pct",
    "vbus",
    "wake",
  ];

  function emptySample(t) {
    return {
      t,
      temperature: null,
      humidity: null,
      batteryPct: null,
      batteryV: null,
      batteryMA: null,
      accel: { x: null, y: null, z: null },
      vbus: null,
      wake: null,
      chg: null,
      err: null,
      source: null,
      linkName: null,
    };
  }

  function hasAny(sample) {
    return (
      sample.temperature != null ||
      sample.humidity != null ||
      sample.batteryPct != null ||
      sample.batteryV != null ||
      sample.batteryMA != null ||
      sample.accel.x != null ||
      sample.vbus != null ||
      sample.wake != null
    );
  }

  function extractSample(event) {
    if (!event || event.type !== "uplink") {
      return null;
    }

    const sample = emptySample(parseTs(event));
    sample.linkName = event.link_name || null;

    const pj = event.payload_json;
    const looksTelemetry =
      pj && typeof pj === "object" && TELEMETRY_KEYS.some((k) => k in pj);

    if (looksTelemetry) {
      sample.source = "telemetry";
      const t = num(pj.t_mc);
      if (t != null) sample.temperature = t / 1000;
      const rh = num(pj.rh_mpc);
      if (rh != null) sample.humidity = rh / 1000;
      const ax = num(pj.ax_mms2);
      const ay = num(pj.ay_mms2);
      const az = num(pj.az_mms2);
      if (ax != null) sample.accel.x = ax / 1000;
      if (ay != null) sample.accel.y = ay / 1000;
      if (az != null) sample.accel.z = az / 1000;
      const mv = num(pj.bat_mv);
      if (mv != null) sample.batteryV = mv / 1000;
      const ua = num(pj.ibat_ua);
      if (ua != null) sample.batteryMA = ua / 1000;
      const pct = num(pj.bat_pct);
      if (pct != null) sample.batteryPct = pct;
      if (typeof pj.vbus === "boolean") sample.vbus = pj.vbus;
      if (typeof pj.wake === "boolean") sample.wake = pj.wake;
      sample.chg = num(pj.chg);
      sample.err = num(pj.err);
    } else if (event.payload_hex) {
      const decoded = decodeSidDemo(event.payload_hex);
      if (decoded && decoded.temperatureC != null) {
        sample.source = "notify";
        sample.temperature = decoded.temperatureC;
      }
    }

    if (event.semantic === "button_press") {
      sample.source = sample.source || "button";
    }

    return hasAny(sample) ? sample : null;
  }

  // Best-effort decode of the binary sid_demo message (TLV body).
  // Header byte: bit7 status-hdr, bits5-6 opcode, bits3-4 class, bits0-2 cmd id.
  // TLV byte:    bits6-7 size class (0:1B 1:2B 2:4B 3:len-prefixed), bits0-5 tag.
  // Multi-byte values are little-endian (nRF native); temperature uses a
  // sanity heuristic so a big-endian build still resolves to a plausible value.
  function decodeSidDemo(hex) {
    let bytes;
    try {
      const clean = hex.replace(/[^0-9a-f]/gi, "");
      if (clean.length < 2 || clean.length % 2 !== 0) {
        return null;
      }
      bytes = new Uint8Array(clean.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
      }
    } catch (err) {
      return null;
    }

    let off = 0;
    const header = bytes[off++];
    const statusHdr = (header >> 7) & 0x1;
    if (statusHdr) {
      off++; // status code
    }

    const result = { temperatureC: null, gpsTimeSec: null, buttons: null, linkType: null };
    let safety = 0;
    while (off < bytes.length && safety++ < 64) {
      const tl = bytes[off++];
      const sizeClass = (tl >> 6) & 0x3;
      const tag = tl & 0x3f;
      let len;
      if (sizeClass === 0) len = 1;
      else if (sizeClass === 1) len = 2;
      else if (sizeClass === 2) len = 4;
      else len = bytes[off++];
      if (len == null || off + len > bytes.length) {
        break;
      }
      const value = bytes.subarray(off, off + len);
      off += len;

      switch (tag) {
        case 0x05: // button press notify
          result.buttons = Array.from(value);
          break;
        case 0x06: // temperature (int16, °C)
          result.temperatureC = decodeInt16Plausible(value);
          break;
        case 0x07: // gps time (uint32, seconds)
          result.gpsTimeSec = readUint(value, true);
          break;
        case 0x0c: // link type
          result.linkType = value[0];
          break;
        default:
          break;
      }
    }
    return result;
  }

  function readUint(value, littleEndian) {
    let out = 0;
    if (littleEndian) {
      for (let i = value.length - 1; i >= 0; i--) out = out * 256 + value[i];
    } else {
      for (let i = 0; i < value.length; i++) out = out * 256 + value[i];
    }
    return out;
  }

  function decodeInt16Plausible(value) {
    if (value.length < 2) {
      return value.length === 1 ? value[0] : null;
    }
    const le = (value[1] << 8) | value[0];
    const be = (value[0] << 8) | value[1];
    const sLe = le > 0x7fff ? le - 0x10000 : le;
    const sBe = be > 0x7fff ? be - 0x10000 : be;
    // Ambient temperatures live in a small range; pick the saner interpretation.
    const plausible = (x) => Math.abs(x) <= 150;
    if (plausible(sLe) && !plausible(sBe)) return sLe;
    if (plausible(sBe) && !plausible(sLe)) return sBe;
    return Math.abs(sLe) <= Math.abs(sBe) ? sLe : sBe;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour12: false });
  }

  function hexA(hex, alpha) {
    const c = hex.replace("#", "");
    const r = parseInt(c.substr(0, 2), 16);
    const g = parseInt(c.substr(2, 2), 16);
    const b = parseInt(c.substr(4, 2), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function fmtValue(v, decimals) {
    if (v == null) {
      return "—";
    }
    return Number(v).toFixed(decimals);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // -------------------------------------------------------------------------
  // Chart + stat definitions
  // -------------------------------------------------------------------------
  const CHART_DEFS = [
    {
      id: "temperature",
      title: "Temperature",
      unit: "°C",
      decimals: 1,
      series: [{ key: "v", label: "Temp", color: COLORS.accent }],
      get: (s) => (s.temperature == null ? null : { v: s.temperature }),
    },
    {
      id: "humidity",
      title: "Relative Humidity",
      unit: "%",
      decimals: 1,
      yMin: 0,
      yMax: 100,
      series: [{ key: "v", label: "RH", color: COLORS.blue }],
      get: (s) => (s.humidity == null ? null : { v: s.humidity }),
    },
    {
      id: "battery",
      title: "Battery Level",
      unit: "%",
      decimals: 0,
      yMin: 0,
      yMax: 100,
      series: [{ key: "v", label: "State of charge", color: COLORS.green }],
      get: (s) => (s.batteryPct == null ? null : { v: s.batteryPct }),
    },
    {
      id: "voltage",
      title: "Battery Voltage",
      unit: "V",
      decimals: 2,
      series: [{ key: "v", label: "Vbat", color: COLORS.violet }],
      get: (s) => (s.batteryV == null ? null : { v: s.batteryV }),
    },
    {
      id: "accel",
      title: "Acceleration",
      unit: "m/s²",
      decimals: 2,
      series: [
        { key: "x", label: "X", color: COLORS.accent },
        { key: "y", label: "Y", color: COLORS.violet },
        { key: "z", label: "Z", color: COLORS.green },
      ],
      get: (s) =>
        s.accel.x == null && s.accel.y == null && s.accel.z == null
          ? null
          : { x: s.accel.x, y: s.accel.y, z: s.accel.z },
    },
    {
      id: "current",
      title: "Battery Current",
      unit: "mA",
      decimals: 1,
      series: [{ key: "v", label: "Ibat", color: COLORS.warn }],
      get: (s) => (s.batteryMA == null ? null : { v: s.batteryMA }),
    },
  ];

  const STAT_DEFS = [
    { id: "temperature", label: "Temperature", unit: "°C", decimals: 1, get: (s) => s.temperature },
    { id: "humidity", label: "Humidity", unit: "%", decimals: 1, get: (s) => s.humidity },
    { id: "battery", label: "Battery", unit: "%", decimals: 0, get: (s) => s.batteryPct },
    { id: "voltage", label: "Voltage", unit: "V", decimals: 2, get: (s) => s.batteryV },
    { id: "motion", label: "Motion", kind: "bool", on: "Active", off: "Idle", get: (s) => s.wake },
    { id: "usb", label: "USB Power", kind: "bool", on: "Present", off: "Absent", get: (s) => s.vbus },
  ];

  // -------------------------------------------------------------------------
  // SensorDashboard — owns the DOM, charts, tiles, and the empty state.
  // -------------------------------------------------------------------------
  const SensorDashboard = {
    charts: new Map(),
    statNodes: new Map(),
    chartLatestNodes: new Map(),
    els: {},
    hasData: false,
    lastSampleTs: 0,
    _demoTimer: null,

    init(opts) {
      this.els = {
        stats: opts.stats || null,
        charts: opts.charts || null,
        empty: opts.empty || null,
        lastSeen: opts.lastSeen || null,
        sourceChip: opts.sourceChip || null,
      };

      if (this.els.stats) {
        this._buildStats();
      }
      if (this.els.charts) {
        this._buildCharts();
      }
      this._applyEmptyState();

      if (this._wantsDemo()) {
        this.injectDemo();
      }
    },

    _wantsDemo() {
      try {
        return new URLSearchParams(window.location.search).get("demo") === "1";
      } catch (err) {
        return false;
      }
    },

    _buildStats() {
      this.els.stats.replaceChildren();
      for (const def of STAT_DEFS) {
        const tile = el("div", "stat-tile");
        tile.appendChild(el("span", "stat-label", def.label));
        const valueRow = el("div", "stat-value-row");
        const value = el("strong", "stat-value", "—");
        valueRow.appendChild(value);
        if (def.unit) {
          valueRow.appendChild(el("span", "stat-unit", def.unit));
        }
        tile.appendChild(valueRow);
        this.els.stats.appendChild(tile);
        this.statNodes.set(def.id, { tile, value });
      }
    },

    _buildCharts() {
      this.els.charts.replaceChildren();
      for (const def of CHART_DEFS) {
        const card = el("article", "chart-card");

        const head = el("div", "chart-card-head");
        const titleWrap = el("div", "chart-card-titles");
        titleWrap.appendChild(el("h3", null, def.title));
        if (def.series.length > 1) {
          const legend = el("div", "chart-legend");
          for (const s of def.series) {
            const item = el("span", "chart-legend-item");
            const dot = el("span", "chart-legend-dot");
            dot.style.background = s.color;
            item.appendChild(dot);
            item.appendChild(document.createTextNode(s.label));
            legend.appendChild(item);
          }
          titleWrap.appendChild(legend);
        }
        head.appendChild(titleWrap);

        const latest = el("span", "chart-latest", "—");
        head.appendChild(latest);
        this.chartLatestNodes.set(def.id, latest);
        card.appendChild(head);

        const wrap = el("div", "chart-canvas-wrap");
        const canvas = document.createElement("canvas");
        canvas.className = "chart-canvas";
        wrap.appendChild(canvas);
        card.appendChild(wrap);

        this.els.charts.appendChild(card);

        this.charts.set(
          def.id,
          new TimeSeriesChart(canvas, {
            series: def.series,
            unit: def.unit,
            decimals: def.decimals,
            yMin: def.yMin,
            yMax: def.yMax,
          })
        );
      }
    },

    ingest(event) {
      const sample = extractSample(event);
      if (!sample) {
        return;
      }

      for (const def of CHART_DEFS) {
        const values = def.get(sample);
        if (!values) {
          continue;
        }
        const chart = this.charts.get(def.id);
        if (chart) {
          chart.push(sample.t, values);
        }
        const latestNode = this.chartLatestNodes.get(def.id);
        if (latestNode) {
          if (def.series.length > 1) {
            latestNode.textContent = def.series
              .map((s) => `${s.label} ${fmtValue(values[s.key], def.decimals)}`)
              .join("  ");
          } else {
            latestNode.textContent = `${fmtValue(values.v, def.decimals)} ${def.unit}`;
          }
        }
      }

      for (const def of STAT_DEFS) {
        const raw = def.get(sample);
        const node = this.statNodes.get(def.id);
        if (!node || raw == null) {
          continue;
        }
        if (def.kind === "bool") {
          node.value.textContent = raw ? def.on : def.off;
          node.tile.classList.toggle("stat-tile--on", !!raw);
          node.tile.classList.toggle("stat-tile--off", !raw);
        } else {
          node.value.textContent = fmtValue(raw, def.decimals);
        }
      }

      this.lastSampleTs = sample.t;
      if (this.els.lastSeen) {
        const link = sample.linkName ? ` · ${sample.linkName}` : "";
        this.els.lastSeen.textContent = `Last reading ${fmtTime(sample.t)}${link}`;
      }
      if (this.els.sourceChip && sample.source) {
        const labels = { telemetry: "JSON telemetry", notify: "Binary notify", button: "Button event" };
        this.els.sourceChip.textContent = labels[sample.source] || sample.source;
      }

      if (!this.hasData) {
        this.hasData = true;
        this._applyEmptyState();
      }
    },

    _applyEmptyState() {
      if (this.els.empty) {
        this.els.empty.hidden = this.hasData;
      }
      if (this.els.charts) {
        this.els.charts.hidden = !this.hasData;
      }
      if (this.els.stats) {
        this.els.stats.hidden = !this.hasData;
      }
    },

    reset() {
      this.hasData = false;
      this.lastSampleTs = 0;
      for (const chart of this.charts.values()) {
        chart.reset();
      }
      for (const def of STAT_DEFS) {
        const node = this.statNodes.get(def.id);
        if (node) {
          node.value.textContent = "—";
          node.tile.classList.remove("stat-tile--on", "stat-tile--off");
        }
      }
      for (const node of this.chartLatestNodes.values()) {
        node.textContent = "—";
      }
      if (this.els.lastSeen) {
        this.els.lastSeen.textContent = "No readings yet";
      }
      if (this.els.sourceChip) {
        this.els.sourceChip.textContent = "Awaiting data";
      }
      this._applyEmptyState();
    },

    redrawAll() {
      for (const chart of this.charts.values()) {
        chart.scheduleDraw();
      }
    },

    // ---- Demo data (screenshots / offline preview only; gated by ?demo=1) ---
    injectDemo() {
      if (this._demoTimer) {
        return;
      }
      const now = Date.now();
      const state = { temp: 23.5, rh: 46, pct: 88, v: 4.02, ax: 0.1, ay: -0.2, az: 9.79 };
      const make = (t, wake) => ({
        type: "uplink",
        ts: new Date(t).toISOString(),
        link_name: "LoRa",
        payload_json: {
          t_mc: Math.round(state.temp * 1000),
          rh_mpc: Math.round(state.rh * 1000),
          ax_mms2: Math.round(state.ax * 1000),
          ay_mms2: Math.round(state.ay * 1000),
          az_mms2: Math.round(state.az * 1000),
          bat_mv: Math.round(state.v * 1000),
          ibat_ua: Math.round((wake ? -42 : 18) * 1000),
          bat_pct: Math.round(state.pct),
          vbus: false,
          wake: !!wake,
          chg: 1,
          err: 0,
        },
      });
      const step = (wake) => {
        state.temp += (Math.random() - 0.45) * 0.4;
        state.rh += (Math.random() - 0.5) * 1.2;
        state.pct = Math.max(0, state.pct - Math.random() * 0.12);
        state.v += (Math.random() - 0.5) * 0.01;
        state.ax = (Math.random() - 0.5) * (wake ? 4 : 0.4);
        state.ay = (Math.random() - 0.5) * (wake ? 4 : 0.4);
        state.az = 9.8 + (Math.random() - 0.5) * (wake ? 3 : 0.3);
      };

      // Backfill ~36 points over the last ~18 minutes so charts look alive.
      for (let i = 36; i >= 1; i--) {
        const wake = i % 7 === 0;
        step(wake);
        this.ingest(make(now - i * 30_000, wake));
      }
      this._demoTimer = window.setInterval(() => {
        const wake = Math.random() < 0.15;
        step(wake);
        this.ingest(make(Date.now(), wake));
      }, 4000);
    },
  };

  window.SidewalkSensors = {
    SensorDashboard,
    TimeSeriesChart,
    extractSample,
    decodeSidDemo,
  };
})();
