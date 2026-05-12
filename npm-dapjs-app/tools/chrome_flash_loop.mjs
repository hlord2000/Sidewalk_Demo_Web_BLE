import http from "node:http"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const APP_URL = process.env.DAPJS_APP_URL || "http://127.0.0.1:4173/"
const DEBUG_PORT = Number.parseInt(process.env.CHROME_DEBUG_PORT || "9222", 10)
const CHROME_PROFILE = process.env.DAPJS_CHROME_PROFILE || "/tmp/sidewalk-dapjs-chrome"
const CHROME_BIN = process.env.CHROME_BIN || "/usr/bin/google-chrome-stable"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(argv) {
  const args = {
    hex: "",
    action: "flash",
    launch: true,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--hex") {
      args.hex = argv[index + 1] || ""
      index += 1
    } else if (value === "--action") {
      args.action = argv[index + 1] || args.action
      index += 1
    } else if (value === "--no-launch") {
      args.launch = false
    }
  }

  if (!args.hex) {
    throw new Error("Usage: node tools/chrome_flash_loop.mjs --hex /abs/path/merged.hex [--action flash|recover]")
  }

  return args
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`)
  }
  return response.json()
}

async function waitForChrome(debugPort, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`http://127.0.0.1:${debugPort}/json/version`)
    } catch (_error) {
      await sleep(200)
    }
  }
  throw new Error(`Timed out waiting for Chrome debug port ${debugPort}.`)
}

function launchChrome() {
  const child = spawn(CHROME_BIN, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    "--new-window",
    "--no-first-run",
    "--disable-default-apps",
    APP_URL,
  ], {
    detached: true,
    stdio: "ignore",
  })

  child.unref()
}

async function getOrCreateTarget(debugPort, url) {
  const list = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`)
  const existing = list.find((target) => target.type === "page" && typeof target.url === "string" && target.url.startsWith(url))
  if (existing) {
    return existing
  }

  try {
    return await fetchJson(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
  } catch (_error) {
    return await fetchJson(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`)
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      this.ws = ws

      ws.onopen = () => resolve()
      ws.onerror = (event) => reject(new Error(event?.message || "WebSocket open failed"))
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.id) {
          const entry = this.pending.get(message.id)
          if (!entry) {
            return
          }
          this.pending.delete(message.id)
          if (message.error) {
            entry.reject(new Error(message.error.message))
          } else {
            entry.resolve(message.result)
          }
          return
        }

      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId
    this.nextId += 1

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, { awaitPromise = true, userGesture = false } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      userGesture,
      returnByValue: true,
    })

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed")
    }

    return result.result?.value
  }
  async close() {
    if (this.ws) {
      this.ws.close()
    }
  }
}

async function waitForHook(client, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const version = await client.evaluate("window.__dapjsApp?.version || ''")
    if (version) {
      return version
    }
    await sleep(200)
  }
  throw new Error("Timed out waiting for window.__dapjsApp.")
}

function createHexServer(hexPath) {
  const fileName = path.basename(hexPath)

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (_request, response) => {
      try {
        const body = await readFile(hexPath, "utf8")
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        })
        response.end(body)
      } catch (error) {
        response.writeHead(500, {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        })
        response.end(String(error.message || error))
      }
    })

    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve({
        server,
        fileName,
        url: `http://127.0.0.1:${address.port}/${encodeURIComponent(fileName)}`,
      })
    })
  })
}

async function printNewLogs(client, seenCount) {
  const logs = await client.evaluate("window.__dapjsApp.getLogs()")
  const newCount = Math.max(0, logs.length - seenCount)
  const fresh = logs.slice(0, newCount).reverse()
  for (const line of fresh) {
    process.stdout.write(`${line}\n`)
  }
  return logs.length
}

async function waitUntilIdle(client, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  let seenCount = 0
  let sawBusy = false

  while (Date.now() < deadline) {
    seenCount = await printNewLogs(client, seenCount)
    const state = await client.evaluate("window.__dapjsApp.getState()")
    if (state.busy) {
      sawBusy = true
    } else if (sawBusy) {
      seenCount = await printNewLogs(client, seenCount)
      return state
    }
    await sleep(300)
  }

  throw new Error("Timed out waiting for app to become idle.")
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  try {
    await waitForChrome(DEBUG_PORT, 1000)
  } catch (_error) {
    if (!args.launch) {
      throw new Error(`Chrome debug port ${DEBUG_PORT} is not available.`)
    }
    launchChrome()
    console.log(`Launched Chrome with remote debugging on ${DEBUG_PORT}.`)
    console.log(`Profile: ${CHROME_PROFILE}`)
  }

  await waitForChrome(DEBUG_PORT, 15000)
  const target = await getOrCreateTarget(DEBUG_PORT, APP_URL)
  const client = new CdpClient(target.webSocketDebuggerUrl)
  await client.connect()

  try {
    await client.send("Page.enable")
    await client.send("Runtime.enable")
    await client.send("Page.navigate", { url: APP_URL })
    await sleep(500)
    const version = await waitForHook(client, 15000)
    console.log(`Connected to page hook ${version}`)

    const hexServer = await createHexServer(path.resolve(args.hex))
    try {
      await client.evaluate("window.__dapjsApp.clearLogs()")
      await client.evaluate(`(async () => {
        const response = await fetch(${JSON.stringify(hexServer.url)})
        const text = await response.text()
        return window.__dapjsApp.loadHexText(${JSON.stringify(hexServer.fileName)}, text)
      })()`)
      await printNewLogs(client, 0)

      if (args.action === "recover") {
        await client.evaluate("window.__dapjsApp.recover(); 'started'", { awaitPromise: false, userGesture: true })
      } else {
        await client.evaluate("window.__dapjsApp.useAuthorizedProbe(); 'started'", { awaitPromise: false, userGesture: true })
        await waitUntilIdle(client, 60000)
        await client.evaluate("window.__dapjsApp.flash(); 'started'", { awaitPromise: false, userGesture: true })
      }

      const finalState = await waitUntilIdle(client, 240000)
      console.log("--- final state ---")
      console.log(JSON.stringify(finalState, null, 2))
    } finally {
      hexServer.server.close()
    }
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
