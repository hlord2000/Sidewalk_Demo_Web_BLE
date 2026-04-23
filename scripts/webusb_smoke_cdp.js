#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const PAGE_PATH = "/static/webusb-smoke.html";
const DEVICE_NAME_PATTERN = /CMSIS-DAP/i;
const PAGE_TIMEOUT_MS = 60_000;
const PROFILE_DIR = path.join(REPO_ROOT, ".webusb-smoke-profile");

class CdpConnection {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;

      const onOpen = () => {
        socket.removeEventListener("error", onError);
        resolve();
      };
      const onError = (event) => {
        socket.removeEventListener("open", onOpen);
        reject(event.error || new Error(`Failed to connect to ${this.url}`));
      };

      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      });
      socket.addEventListener("close", () => {
        const error = new Error(`CDP socket closed for ${this.url}`);
        for (const { reject } of this.pending.values()) {
          reject(error);
        }
        this.pending.clear();
      });
    });
  }

  close() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }

  handleMessage(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    if (!message.method) {
      return;
    }

    const remaining = [];
    for (const waiter of this.waiters) {
      const methodMatch = waiter.method === message.method;
      const predicateMatch = !waiter.predicate || waiter.predicate(message);
      if (methodMatch && predicateMatch) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  waitFor(method, predicate = null, timeoutMs = PAGE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.waiters.push({ method, predicate, resolve, reject, timer });
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForHttp(url, timeoutMs = PAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function waitForJson(url, timeoutMs = PAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || REPO_ROOT,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    env: options.env || process.env,
  });

  let stdout = "";
  let stderr = "";
  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
  }

  child.capture = () => ({ stdout, stderr });
  return child;
}

function chooseChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error) {
      return candidate;
    }
  }
  throw new Error("No Chrome or Chromium binary was found.");
}

async function evaluate(connection, sessionId, expression) {
  const result = await connection.send(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(`Runtime.evaluate failed for ${expression}`);
  }
  return result.result.value;
}

async function waitForPageReady(connection, sessionId) {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await evaluate(connection, sessionId, "window.__webusbSmokeResult || null");
    if (state && state.phase && state.phase !== "booting") {
      return state;
    }
    await sleep(200);
  }
  throw new Error("Timed out waiting for window.__webusbSmokeResult to initialize.");
}

async function clickButton(connection, sessionId, buttonId) {
  await connection.send("Page.bringToFront", {}, sessionId);
  const result = await connection.send(
    "Runtime.evaluate",
    {
      expression: `
        (() => {
          const button = document.getElementById(${JSON.stringify(buttonId)});
          if (!button) {
            return null;
          }
          button.scrollIntoView({ block: "center", inline: "center" });
          button.click();
          return {
            id: button.id,
            label: button.textContent.trim()
          };
        })()
      `,
      returnByValue: true,
      userGesture: true,
    },
    sessionId,
  );
  if (!result.result.value) {
    throw new Error(`Could not find #${buttonId} in the smoke test page.`);
  }
  console.log(`Triggered ${result.result.value.id} (${result.result.value.label}) with Runtime.evaluate userGesture.`);
}

async function waitForResult(connection, sessionId) {
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await evaluate(connection, sessionId, "window.__webusbSmokeResult || null");
    if (result && (result.phase === "done" || result.phase === "error")) {
      return result;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for the smoke test result.");
}

async function main() {
  const httpPort = await getFreePort();
  const cdpPort = await getFreePort();
  const pageUrl = `http://127.0.0.1:${httpPort}${PAGE_PATH}`;
  const httpServer = spawnProcess("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], {
    cwd: REPO_ROOT,
  });

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const chromeBinary = chooseChromeBinary();
  const chrome = spawnProcess(
    chromeBinary,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--new-window",
      "about:blank",
    ],
    { cwd: REPO_ROOT },
  );

  const cleanup = async () => {
    try {
      httpServer.kill("SIGTERM");
    } catch (error) {
      // Ignore cleanup failures.
    }
    try {
      chrome.kill("SIGTERM");
    } catch (error) {
      // Ignore cleanup failures.
    }
    await sleep(300);
  };

  try {
    await waitForHttp(pageUrl);
    const version = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`);
    const browser = new CdpConnection(version.webSocketDebuggerUrl);
    await browser.connect();

    const created = await browser.send("Target.createTarget", { url: pageUrl });
    const targetId = created.targetId;
    await browser.send("Target.activateTarget", { targetId });
    const attached = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached.sessionId;
    await browser.send("Page.enable", {}, sessionId);
    await browser.send("Runtime.enable", {}, sessionId);
    await browser.send("DeviceAccess.enable", {}, sessionId);

    await waitForPageReady(browser, sessionId);
    console.log(`Opened ${pageUrl}`);
    const authorizedCount = await evaluate(
      browser,
      sessionId,
      "(navigator.usb && navigator.usb.getDevices ? navigator.usb.getDevices().then((devices) => devices.length) : 0)",
    );
    console.log(`Authorized devices in profile: ${authorizedCount}`);

    let result;
    let manualSelection = false;

    if (authorizedCount > 0) {
      await clickButton(browser, sessionId, "use-authorized-device");
      console.log("Clicked authorized device button.");
      result = await waitForResult(browser, sessionId);
    } else {
      const promptPromise = browser.waitFor(
        "DeviceAccess.deviceRequestPrompted",
        (message) => message.sessionId === sessionId,
        PAGE_TIMEOUT_MS,
      ).then((prompt) => ({ kind: "prompt", prompt })).catch(() => ({ kind: "prompt-timeout" }));
      const resultPromise = waitForResult(browser, sessionId)
        .then((pageResult) => ({ kind: "result", result: pageResult }))
        .catch((resultError) => ({ kind: "result-error", error: resultError }));
      await clickButton(browser, sessionId, "request-device");
      console.log("Clicked request button.");

      const firstEvent = await Promise.race([promptPromise, resultPromise]);
      if (firstEvent.kind === "prompt") {
        const devices = firstEvent.prompt.params.devices || [];
        const chosen = devices.find((device) => DEVICE_NAME_PATTERN.test(device.name)) || devices[0];
        if (!chosen) {
          throw new Error("Chrome opened the chooser, but no USB devices were listed.");
        }

        await browser.send("DeviceAccess.selectPrompt", {
          id: firstEvent.prompt.params.id,
          deviceId: chosen.id,
        }, sessionId);
        result = await waitForResult(browser, sessionId);
      } else if (firstEvent.kind === "result") {
        manualSelection = true;
        result = firstEvent.result;
      } else if (firstEvent.kind === "prompt-timeout") {
        manualSelection = true;
        result = await waitForResult(browser, sessionId);
      } else {
        throw firstEvent.error;
      }
    }

    if (!result.ok) {
      throw new Error(result.error || result.summary || "Smoke test failed.");
    }

    if (manualSelection) {
      console.log("Chooser completed without a DevTools DeviceAccess event. Manual selection path was used.");
    }
    console.log(`Smoke test passed for ${result.selectedDevice}`);
    console.log(`Interface: ${result.interfaceLabel}`);
    console.log(`Packet size: ${result.packetSize} bytes`);
    for (const [key, value] of Object.entries(result.info || {})) {
      if (!value || value === "-") {
        continue;
      }
      console.log(`${key}: ${value}`);
    }
    browser.close();
  } catch (error) {
    const serverLogs = httpServer.capture();
    const chromeLogs = chrome.capture();
    try {
      const version = await waitForJson(`http://127.0.0.1:${cdpPort}/json/version`, 1000);
      const browser = new CdpConnection(version.webSocketDebuggerUrl);
      await browser.connect();
      const targets = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`, 1000);
      const pageTarget = targets.find((target) => target.url === pageUrl);
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        const pageConnection = new CdpConnection(pageTarget.webSocketDebuggerUrl);
        await pageConnection.connect();
        const state = await pageConnection.send("Runtime.evaluate", {
          expression: "window.__webusbSmokeResult || null",
          returnByValue: true,
          awaitPromise: true,
        });
        console.error(`Page state: ${JSON.stringify(state.result.value)}`);
        pageConnection.close();
      }
      browser.close();
    } catch (stateError) {
      console.error(`Could not capture page state: ${stateError.message}`);
    }
    console.error(`Smoke test failed: ${error.message || error}`);
    if (serverLogs.stderr.trim()) {
      console.error(`HTTP server stderr:\n${serverLogs.stderr.trim()}`);
    }
    if (chromeLogs.stderr.trim()) {
      console.error(`Chrome stderr:\n${chromeLogs.stderr.trim()}`);
    }
    throw error;
  } finally {
    await cleanup();
  }
}

main().catch(() => {
  process.exitCode = 1;
});
