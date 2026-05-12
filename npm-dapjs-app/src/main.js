import "./style.css"
import * as DAPjs from "dapjs"

const REQUEST_FILTERS = [
  { vendorId: 0x2886, productId: 0x0066 },
  { vendorId: 0x0d28 },
]

const FLASH_STUB = {
  loadAddress: 0x20000000,
  instructions: [
    0xbf00be00, 0x4c28b510, 0x60202000, 0x60204c27, 0xf2424c27, 0x60210101,
    0x68214c26, 0x0f01f011, 0x4c25d0fa, 0xf0116821, 0xd0fa0f01, 0xbd102000,
    0x4b1eb5f0, 0x601c2400, 0x4b1fb152, 0xf014681c, 0xd0fa0f01, 0x4b04f851,
    0x4b04f840, 0xd1f43a01, 0x681c4b18, 0x0f01f014, 0x4b18d0fa, 0xf014681c,
    0xd10c0f01, 0x24014b16, 0x4b12601c, 0xf014681c, 0xd0fa0f01, 0x681c4b11,
    0x0f01f014, 0x4b0bd0f5, 0xf014681c, 0xd0020f01, 0x68184b0e, 0x2000bdf0,
    0xb510bdf0, 0x20004c06, 0x4c066020, 0xf0116821, 0xd0fa0f01, 0xbd102000,
    0x5004b50c, 0x5004b10c, 0x5004b500, 0x5004b400, 0x5004b404, 0x5004b410,
    0x5004b008, 0x5004b408,
  ],
  pcInit: 0x20000005,
  pcProgram: 0x20000031,
  pcUnInit: 0x20000093,
  beginStack: 0x20000800,
  staticBase: 0x200000c8,
  pageBuffers: [0x20001000],
  bufferBytes: 4096,
}
const FLASH_STUB_CODE = new Uint32Array(FLASH_STUB.instructions)

const CORE = {
  R0: 0,
  R1: 1,
  R2: 2,
  R3: 3,
  R9: 9,
  SP: 13,
  LR: 14,
  PC: 15,
  PSR: 16,
}

const DEBUG = {
  DFSR: 0xe000ed30,
  AIRCR: 0xe000ed0c,
  DHCSR: 0xe000edf0,
  DEMCR: 0xe000edfc,
}

const MASKS = {
  DBGKEY: 0xa05f0000,
  C_DEBUGEN: 0x00000001,
  C_HALT: 0x00000002,
  S_HALT: 0x00020000,
  DEMCR_VC_CORERESET: 0x00000001,
  AIRCR_VECTKEY: 0x05fa0000,
  AIRCR_SYSRESETREQ: 0x00000004,
  AIRCR_PRIGROUP_MASK: 0x00000700,
  XPSR_THUMB: 0x01000000,
  DFSR_CLEAR_ALL: 0x0000001f,
}

const ACCESS_PORT = {
  AHB: 0,
  CTRL: 2,
}

const ACCESS_PORT_REG = {
  CSW: 0x000,
}

const CTRL_AP = {
  RESET: 0x000,
  ERASEALL: 0x004,
  ERASEALLSTATUS: 0x008,
  ERASEPROTECTSTATUS: 0x00c,
  APPROTECTSTATUS: 0x014,
  IDR: 0x0fc,
}

const CTRL_AP_STATUS = {
  READY_TO_RESET: 0x1,
  BUSY: 0x2,
}

const CTRL_AP_RESET_PULSE = 0x2
const CTRL_AP_IDR_EXPECTED = 0x32880000
const CSW_DEVICEEN = 0x00000040
const MASS_ERASE_TIMEOUT_MS = 30000
const IMAGE_CHUNK_BYTES = 4096
const APP_BUILD_STAMP = "2026-04-23T16:10-04:00 stock-dapjs-webusb padded-read tuned-proxy manual-stub-runner"
const DEFAULT_DEBUG_CLOCK_HZ = 1000000
const DEBUG_CLOCK_OPTIONS = [1000000, 4000000, 8000000, 12000000]
const CMSIS_DAP_MAX_OPERATION_COUNT = 4
const CMSIS_DAP_MAX_BLOCK_BYTES = 32
const CMSIS_DAP_FALLBACK_OPERATION_COUNT = 1
const CMSIS_DAP_FALLBACK_BLOCK_BYTES = 16
const FLASH_LIMITS = [
  { start: 0x00000000, end: 0x0017d000 },
  { start: 0x00ffd000, end: 0x00ffe000 },
]

const state = {
  busy: false,
  device: null,
  transport: null,
  processor: null,
  probeLabel: "",
  image: null,
  logLines: [],
  debugClockHz: DEFAULT_DEBUG_CLOCK_HZ,
  verifyAfterFlash: false,
}

const ui = {}

function formatHex(value, width = 8) {
  return `0x${(value >>> 0).toString(16).padStart(width, "0")}`
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function sliceDataView(view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function padDataView(view, minLength) {
  if (view.byteLength >= minLength) {
    return view
  }

  const padded = new Uint8Array(minLength)
  padded.set(sliceDataView(view))
  return new DataView(padded.buffer)
}

function apRegister(apNumber, register) {
  return ((apNumber << 24) | register) >>> 0
}

function validateWordAddress(address) {
  for (const region of FLASH_LIMITS) {
    if (address >= region.start && (address + 4) <= region.end) {
      return
    }
  }
  throw new Error(`Image contains unsupported address ${formatHex(address)}`)
}

function parseIntelHex(text, name = "image.hex") {
  const lines = text.split(/\r?\n/)
  const words = new Map()
  let upperAddress = 0
  let endSeen = false
  let actualByteCount = 0

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    if (!line.startsWith(":")) {
      throw new Error(`Invalid Intel HEX record: ${line}`)
    }

    const record = line.slice(1)
    if ((record.length % 2) !== 0) {
      throw new Error(`Malformed Intel HEX line: ${line}`)
    }

    const bytes = new Uint8Array(record.length / 2)
    for (let index = 0; index < bytes.length; index += 1) {
      const value = Number.parseInt(record.slice(index * 2, index * 2 + 2), 16)
      if (!Number.isFinite(value)) {
        throw new Error(`Malformed Intel HEX byte in line: ${line}`)
      }
      bytes[index] = value
    }

    let checksum = 0
    for (const value of bytes) {
      checksum = (checksum + value) & 0xff
    }
    if (checksum !== 0) {
      throw new Error(`Checksum mismatch in line: ${line}`)
    }

    const length = bytes[0]
    const offset = (bytes[1] << 8) | bytes[2]
    const type = bytes[3]
    const data = bytes.slice(4, 4 + length)

    if (type === 0x00) {
      const baseAddress = (upperAddress + offset) >>> 0
      for (let index = 0; index < data.length; index += 1) {
        const absoluteAddress = (baseAddress + index) >>> 0
        const wordAddress = absoluteAddress & ~0x3
        validateWordAddress(wordAddress)
        const shift = (absoluteAddress & 0x3) * 8
        const current = words.has(wordAddress) ? words.get(wordAddress) : 0xffffffff
        const updated = (current & ~(0xff << shift)) | (data[index] << shift)
        words.set(wordAddress, updated >>> 0)
        actualByteCount += 1
      }
    } else if (type === 0x01) {
      endSeen = true
      break
    } else if (type === 0x02) {
      upperAddress = (((data[0] << 8) | data[1]) << 4) >>> 0
    } else if (type === 0x04) {
      upperAddress = (((data[0] << 8) | data[1]) << 16) >>> 0
    } else if (type === 0x03 || type === 0x05) {
      continue
    } else {
      throw new Error(`Unsupported Intel HEX record type ${type}`)
    }
  }

  if (!endSeen) {
    throw new Error("Intel HEX file is missing an EOF record.")
  }
  if (!words.size) {
    throw new Error("Intel HEX file does not contain any data records.")
  }

  const addresses = Array.from(words.keys()).sort((left, right) => left - right)
  const chunks = []
  let currentStart = null
  let currentWords = []
  let previousAddress = null

  for (const address of addresses) {
    const contiguous = previousAddress !== null && address === (previousAddress + 4)
    const currentBytes = currentWords.length * 4
    if (!contiguous || currentBytes >= IMAGE_CHUNK_BYTES) {
      if (currentWords.length) {
        chunks.push({
          address: currentStart,
          words: new Uint32Array(currentWords),
        })
      }
      currentStart = address
      currentWords = []
    }
    currentWords.push(words.get(address))
    previousAddress = address
  }

  if (currentWords.length) {
    chunks.push({
      address: currentStart,
      words: new Uint32Array(currentWords),
    })
  }

  return {
    name,
    actualByteCount,
    programByteCount: addresses.length * 4,
    chunks,
    firstAddress: addresses[0],
    lastAddress: addresses[addresses.length - 1] + 4,
  }
}

function buildProgramBlocks(image, maxBytes = FLASH_STUB.bufferBytes) {
  const maxWords = Math.max(1, Math.floor(maxBytes / 4))
  const blocks = []

  for (const chunk of image.chunks) {
    let offsetWords = 0
    while (offsetWords < chunk.words.length) {
      const wordCount = Math.min(maxWords, chunk.words.length - offsetWords)
      blocks.push({
        address: chunk.address + (offsetWords * 4),
        words: chunk.words.slice(offsetWords, offsetWords + wordCount),
      })
      offsetWords += wordCount
    }
  }

  return blocks
}

function appendLog(level, message) {
  const timestamp = new Date().toLocaleTimeString()
  state.logLines.unshift(`[${timestamp}] ${level.toUpperCase()}: ${message}`)
  state.logLines = state.logLines.slice(0, 120)
  ui.log.textContent = state.logLines.join("\n")
}

function setStatus(lines) {
  ui.status.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines)
}

function updateProgress(doneBytes, totalBytes) {
  if (!totalBytes) {
    ui.progressLabel.textContent = "0%"
    ui.progressBar.value = 0
    return
  }

  const percent = Math.min(100, Math.round((doneBytes / totalBytes) * 100))
  ui.progressLabel.textContent = `${percent}%`
  ui.progressBar.value = percent
}

function setProbeState(kind, text) {
  ui.probeState.dataset.state = kind
  ui.probeState.textContent = text
}

function updateUi() {
  const hasImage = !!state.image
  const connected = !!state.processor
  const supportsUsb = "usb" in navigator

  ui.requestProbe.disabled = state.busy || !supportsUsb
  ui.useAuthorized.disabled = state.busy || !supportsUsb
  ui.recover.disabled = state.busy || !supportsUsb
  ui.flash.disabled = state.busy || !supportsUsb || !hasImage
  ui.disconnect.disabled = state.busy || !connected

  ui.probeMeta.textContent = state.probeLabel || "No probe connected"
  ui.imageMeta.textContent = state.image
    ? `${state.image.name} | ${state.image.actualByteCount} file bytes | ${state.image.programByteCount} programmed bytes`
    : "No image loaded"
  if (ui.debugClockSelect) {
    ui.debugClockSelect.value = String(state.debugClockHz)
  }
  if (ui.verifyToggle) {
    ui.verifyToggle.checked = state.verifyAfterFlash
  }
}

function buildApp() {
  const root = document.getElementById("app")
  root.innerHTML = `
    <main class="shell">
      <section class="hero">
        <p class="kicker">DAP.js / WebUSB</p>
        <h1>nRF54L15 Flash Console</h1>
        <p class="hero-copy">Standalone npm app. Direct WebUSB probe access with a minimal nRF54L15 recover and flash flow.</p>
      </section>
      <section class="grid">
        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Probe</p>
              <h2>CMSIS-DAP</h2>
            </div>
            <span id="probe-state" class="state-pill" data-state="idle">Ready</span>
          </div>
          <div class="button-row">
            <button id="request-probe">Request Probe</button>
            <button id="use-authorized" class="ghost">Use Authorized</button>
            <button id="disconnect" class="ghost">Disconnect</button>
          </div>
          <p id="probe-meta" class="meta">No probe connected</p>
        </article>
        <article class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Image</p>
              <h2>Intel HEX</h2>
            </div>
            <label for="firmware-file" class="file-button">Choose .hex</label>
          </div>
          <input id="firmware-file" type="file" accept=".hex" />
          <p id="image-meta" class="meta">No image loaded</p>
        </article>
        <article class="panel panel-wide">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Actions</p>
              <h2>Recover And Flash</h2>
            </div>
            <span class="clock-chip" id="clock-chip">${Math.round(DEFAULT_DEBUG_CLOCK_HZ / 1000000)} MHz debug</span>
          </div>
          <div class="options-row">
            <label class="option-field">
              <span>SWD Clock</span>
              <select id="debug-clock">
                ${DEBUG_CLOCK_OPTIONS.map((hz) => `<option value="${hz}" ${hz === DEFAULT_DEBUG_CLOCK_HZ ? "selected" : ""}>${Math.round(hz / 1000000)} MHz</option>`).join("")}
              </select>
            </label>
            <label class="toggle-field">
              <input id="verify-after-flash" type="checkbox">
              <span>Verify After Flash</span>
            </label>
          </div>
          <div class="button-row">
            <button id="recover" class="ghost">Recover nRF54L15</button>
            <button id="flash">Flash Selected Hex</button>
          </div>
          <div class="progress-row">
            <progress id="progress-bar" max="100" value="0"></progress>
            <span id="progress-label">0%</span>
          </div>
          <pre id="status" class="status-box"></pre>
        </article>
        <article class="panel panel-wide">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Log</p>
              <h2>Session</h2>
            </div>
          </div>
          <pre id="log" class="log-box"></pre>
        </article>
      </section>
    </main>
  `

  ui.requestProbe = document.getElementById("request-probe")
  ui.useAuthorized = document.getElementById("use-authorized")
  ui.disconnect = document.getElementById("disconnect")
  ui.recover = document.getElementById("recover")
  ui.flash = document.getElementById("flash")
  ui.fileInput = document.getElementById("firmware-file")
  ui.status = document.getElementById("status")
  ui.log = document.getElementById("log")
  ui.probeMeta = document.getElementById("probe-meta")
  ui.imageMeta = document.getElementById("image-meta")
  ui.probeState = document.getElementById("probe-state")
  ui.progressBar = document.getElementById("progress-bar")
  ui.progressLabel = document.getElementById("progress-label")
  ui.debugClockSelect = document.getElementById("debug-clock")
  ui.verifyToggle = document.getElementById("verify-after-flash")
  ui.clockChip = document.getElementById("clock-chip")
}

async function readSelectedImage(file) {
  const text = await file.text()
  return parseIntelHex(text, file.name)
}

async function waitForHalt(processor, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dhcsr = await processor.readMem32(DEBUG.DHCSR)
    if (dhcsr & MASKS.S_HALT) {
      return dhcsr >>> 0
    }
    await sleep(20)
  }
  throw new Error(message)
}

async function getDebugSnapshot(processor) {
  try {
    const pc = await processor.readCoreRegister(CORE.PC)
    const lr = await processor.readCoreRegister(CORE.LR)
    const dhcsr = await processor.readMem32(DEBUG.DHCSR)
    const dfsr = await processor.readMem32(DEBUG.DFSR)
    return `PC=${formatHex(pc)} LR=${formatHex(lr)} DHCSR=${formatHex(dhcsr)} DFSR=${formatHex(dfsr)}`
  } catch (error) {
    return `debug snapshot unavailable: ${error.message}`
  }
}

async function forceHalt(processor) {
  await processor.writeMem32(DEBUG.DHCSR, MASKS.DBGKEY | MASKS.C_DEBUGEN | MASKS.C_HALT)
  await waitForHalt(processor, 2000, "Timed out waiting for the target to halt.")
}

async function resetAndHalt(processor) {
  const oldDemcr = await processor.readMem32(DEBUG.DEMCR)
  await processor.writeMem32(DEBUG.DFSR, MASKS.DFSR_CLEAR_ALL)
  await processor.writeMem32(DEBUG.DHCSR, MASKS.DBGKEY | MASKS.C_DEBUGEN | MASKS.C_HALT)
  await processor.writeMem32(DEBUG.DEMCR, oldDemcr | MASKS.DEMCR_VC_CORERESET)

  const aircr = await processor.readMem32(DEBUG.AIRCR)
  const prigroup = aircr & MASKS.AIRCR_PRIGROUP_MASK
  await processor.writeMem32(DEBUG.AIRCR, MASKS.AIRCR_VECTKEY | prigroup | MASKS.AIRCR_SYSRESETREQ)

  await waitForHalt(processor, 4000, "Timed out waiting for target halt during flash init.")
  await processor.writeMem32(DEBUG.DEMCR, oldDemcr)
  await processor.writeMem32(DEBUG.DFSR, MASKS.DFSR_CLEAR_ALL)
}

async function executeFlashStub(processor, pc, args = [], timeoutMs = 10000, label = "Flash stub execution") {
  const proxy = processor?.proxy
  const previousOperationCount = proxy?.operationCount
  const previousBlockSize = proxy?.blockSize

  if (proxy) {
    proxy.operationCount = CMSIS_DAP_FALLBACK_OPERATION_COUNT
    proxy.blockSize = Math.min(proxy.blockSize ?? CMSIS_DAP_FALLBACK_BLOCK_BYTES, CMSIS_DAP_FALLBACK_BLOCK_BYTES)
  }

  try {
    await forceHalt(processor)
    await processor.writeMem32(DEBUG.DFSR, MASKS.DFSR_CLEAR_ALL)
    await processor.writeCoreRegister(CORE.SP, FLASH_STUB.beginStack)
    await processor.writeCoreRegister(CORE.PC, pc)
    await processor.writeCoreRegister(CORE.LR, FLASH_STUB.loadAddress + 1)

    for (let index = 0; index < Math.min(args.length, 4); index += 1) {
      await processor.writeCoreRegister(index, args[index] >>> 0)
    }

    await processor.writeCoreRegister(CORE.PSR, MASKS.XPSR_THUMB)
    await processor.resume(false)
    await waitForHalt(processor, timeoutMs, `${label} timed out waiting for halt.`)
  } catch (error) {
    throw new Error(`${label} failed: ${error.message}`)
  } finally {
    if (proxy) {
      proxy.operationCount = previousOperationCount
      proxy.blockSize = previousBlockSize
    }
  }

  const result = await processor.readCoreRegister(CORE.R0)
  return result >>> 0
}

async function softResetAndRun(processor) {
  const aircr = await processor.readMem32(DEBUG.AIRCR)
  const prigroup = aircr & MASKS.AIRCR_PRIGROUP_MASK
  await processor.writeMem32(DEBUG.DEMCR, 0)
  await processor.writeMem32(DEBUG.DFSR, MASKS.DFSR_CLEAR_ALL)
  await processor.writeMem32(DEBUG.DHCSR, MASKS.DBGKEY | MASKS.C_DEBUGEN)
  await processor.writeMem32(DEBUG.AIRCR, MASKS.AIRCR_VECTKEY | prigroup | MASKS.AIRCR_SYSRESETREQ)
}

async function readAccessState(processor) {
  const ctrlApIdr = await processor.readAP(apRegister(ACCESS_PORT.CTRL, CTRL_AP.IDR))
  const ahbCsw = await processor.readAP(apRegister(ACCESS_PORT.AHB, ACCESS_PORT_REG.CSW))
  const approtectStatus = await processor.readAP(apRegister(ACCESS_PORT.CTRL, CTRL_AP.APPROTECTSTATUS))
  const eraseProtectStatus = await processor.readAP(apRegister(ACCESS_PORT.CTRL, CTRL_AP.ERASEPROTECTSTATUS))

  return {
    ctrlApIdr: ctrlApIdr >>> 0,
    ahbCsw: ahbCsw >>> 0,
    approtectStatus: approtectStatus >>> 0,
    eraseProtectStatus: eraseProtectStatus >>> 0,
    ctrlApOk: (ctrlApIdr >>> 0) === CTRL_AP_IDR_EXPECTED,
    deviceEnabled: !!(ahbCsw & CSW_DEVICEEN),
  }
}

function formatAccessState(access) {
  return [
    `CTRL-AP IDR=${formatHex(access.ctrlApIdr)}`,
    `AHB-CSW=${formatHex(access.ahbCsw)}`,
    `APPROTECT=${formatHex(access.approtectStatus)}`,
    `ERASEPROTECT=${formatHex(access.eraseProtectStatus)}`,
  ].join(" ")
}

async function ensureFlashAccess(processor) {
  const access = await readAccessState(processor)
  if (!access.ctrlApOk) {
    appendLog("warn", `Unexpected CTRL-AP IDR. ${formatAccessState(access)}`)
  }
  if (!access.deviceEnabled) {
    throw new Error(`Target bus access is disabled. ${formatAccessState(access)}. Recover first.`)
  }
  return access
}

async function waitForCtrlApEraseStatus(processor, acceptedStates, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await processor.readAP(apRegister(ACCESS_PORT.CTRL, CTRL_AP.ERASEALLSTATUS))
    if (acceptedStates.includes(status >>> 0)) {
      return status >>> 0
    }
    await sleep(100)
  }
  throw new Error(message)
}

async function massEraseAndReconnect(processor, reason = "chip erase") {
  appendLog("warn", `Starting Nordic CTRL-AP ${reason}.`)
  await processor.writeAP(apRegister(ACCESS_PORT.CTRL, CTRL_AP.ERASEALL), 1)
  await waitForCtrlApEraseStatus(
    processor,
    [CTRL_AP_STATUS.BUSY, CTRL_AP_STATUS.READY_TO_RESET],
    5000,
    "Mass erase did not start on CTRL-AP.",
  )
  await waitForCtrlApEraseStatus(
    processor,
    [CTRL_AP_STATUS.READY_TO_RESET],
    MASS_ERASE_TIMEOUT_MS,
    "Timed out waiting for CTRL-AP erase completion.",
  )

  await sleep(10)
  await processor.writeAP(apRegister(ACCESS_PORT.CTRL, CTRL_AP.RESET), CTRL_AP_RESET_PULSE)
  await processor.writeAP(apRegister(ACCESS_PORT.CTRL, CTRL_AP.RESET), 0)
  await sleep(200)
  await processor.reconnect()

  return ensureFlashAccess(processor)
}

async function recoverTarget(processor) {
  appendLog("warn", "Starting Nordic CTRL-AP recover sequence.")
  setStatus(["nRF54L15 recover", "", "Issuing Nordic CTRL-AP mass erase and unlock."])

  const access = await massEraseAndReconnect(processor, "recover sequence")
  appendLog("info", `Recover complete. ${formatAccessState(access)}`)
  setStatus(["nRF54L15 recover complete.", formatAccessState(access)])
}

async function initFlashStub(processor) {
  for (let index = 0; index < FLASH_STUB_CODE.length; index += 1) {
    await processor.writeMem32(FLASH_STUB.loadAddress + (index * 4), FLASH_STUB_CODE[index] >>> 0)
  }

  const result = await executeFlashStub(
    processor,
    FLASH_STUB.pcInit,
    [0, 0, 0, 0],
    10000,
    "Flash stub init",
  )
  if (result !== 0) {
    throw new Error(`Flash stub init failed with ${formatHex(result)}.`)
  }
}

async function uninitFlashStub(processor) {
  const result = await executeFlashStub(
    processor,
    FLASH_STUB.pcUnInit,
    [0, 0, 0, 0],
    10000,
    "Flash stub uninit",
  )
  if (result !== 0) {
    throw new Error(`Flash stub uninit failed with ${formatHex(result)}.`)
  }
}

async function programFlashBlock(processor, block) {
  if (!block.words.length) {
    return
  }

  const bufferAddress = FLASH_STUB.pageBuffers[0]
  await processor.writeBlock(bufferAddress, block.words)

  const timeoutMs = Math.max(10000, Math.ceil((block.words.length * 4) / 8))
  const result = await executeFlashStub(
    processor,
    FLASH_STUB.pcProgram,
    [block.address, bufferAddress, block.words.length, 0],
    timeoutMs,
    `Flash stub program ${formatHex(block.address)}`,
  )

  if (result !== 0) {
    throw new Error(`Flash stub reported an RRAM access error at ${formatHex(result)}.`)
  }
}

async function verifyImage(processor, image) {
  appendLog("info", "Verifying programmed flash contents.")
  for (let index = 0; index < image.chunks.length; index += 1) {
    const chunk = image.chunks[index]
    const readBack = await processor.readBlock(chunk.address, chunk.words.length)
    for (let wordIndex = 0; wordIndex < chunk.words.length; wordIndex += 1) {
      const expected = chunk.words[wordIndex] >>> 0
      const actual = readBack[wordIndex] >>> 0
      if (actual !== expected) {
        throw new Error(`Verify failed at ${formatHex(chunk.address + (wordIndex * 4))}: expected ${formatHex(expected)} got ${formatHex(actual)}.`)
      }
    }
  }
}

async function releaseProbe() {
  const processor = state.processor
  try {
    if (processor) {
      try {
        await softResetAndRun(processor)
      } catch (error) {
        appendLog("warn", `Reset after session failed: ${error.message}`)
      }
      await processor.disconnect()
    }
  } catch (error) {
    appendLog("warn", `Disconnect failed: ${error.message}`)
  } finally {
    state.processor = null
    state.transport = null
    state.device = null
    state.probeLabel = ""
    updateUi()
  }
}

function formatUsbId(device) {
  return `${formatHex(device.vendorId, 4)}:${formatHex(device.productId, 4)}`
}

function describeUsbInterfaces(device) {
  const configuration = device.configuration
  if (!configuration) {
    return "USB configuration: none selected"
  }

  const lines = [`USB configuration ${configuration.configurationValue ?? "?"}`]
  for (const usbInterface of configuration.interfaces || []) {
    const alternates = usbInterface.alternates || (usbInterface.alternate ? [usbInterface.alternate] : [])
    const alternateSummary = alternates.map((alternate) => {
      const endpoints = (alternate.endpoints || []).map((endpoint) =>
        `${endpoint.direction}:${endpoint.type}:${endpoint.endpointNumber}:${endpoint.packetSize || 0}`)
      return `alt${alternate.alternateSetting} class=${alternate.interfaceClass} name=${alternate.interfaceName || "-"} eps=[${endpoints.join(" ")}]`
    })
    lines.push(`if${usbInterface.interfaceNumber}: ${alternateSummary.join(" | ")}`)
  }

  return lines.join("\n")
}

class StableWebUSB extends DAPjs.WebUSB {
  async read() {
    const view = await super.read()
    if (view.byteLength >= this.packetSize) {
      return view
    }

    appendLog("warn", `Short CMSIS-DAP packet (${view.byteLength} bytes) padded to ${this.packetSize} bytes.`)
    return padDataView(view, this.packetSize)
  }
}

function tuneCmsisDapProxy(processor) {
  const proxy = processor?.proxy
  if (!proxy) {
    return
  }

  const nextOperationCount = Math.min(proxy.operationCount ?? CMSIS_DAP_MAX_OPERATION_COUNT, CMSIS_DAP_MAX_OPERATION_COUNT)
  const nextBlockSize = Math.min(proxy.blockSize ?? CMSIS_DAP_MAX_BLOCK_BYTES, CMSIS_DAP_MAX_BLOCK_BYTES)
  const changed = proxy.operationCount !== nextOperationCount || proxy.blockSize !== nextBlockSize

  proxy.operationCount = nextOperationCount
  proxy.blockSize = nextBlockSize

  if (changed) {
    appendLog("info", `CMSIS-DAP tuned for XIAO probe: operationCount=${proxy.operationCount} blockSize=${proxy.blockSize}.`)
  }
}

function deviceMatches(device) {
  return (
    (device.vendorId === 0x2886 && device.productId === 0x0066) ||
    /CMSIS-DAP/i.test(device.productName || "")
  )
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId = null
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId)
    }
  })
}

async function connectDevice(device) {
  if (state.processor && state.device === device) {
    appendLog("info", `Reusing connected probe ${state.probeLabel}.`)
    return state.processor
  }

  await releaseProbe()
  appendLog("info", `Connecting ${device.productName || "USB device"} (${formatUsbId(device)}), opened=${device.opened ? "yes" : "no"}.`)
  appendLog("info", describeUsbInterfaces(device))
  const transport = new StableWebUSB(device)

  const processor = new DAPjs.CortexM(transport, 0, state.debugClockHz)
  try {
    appendLog("info", `DAP connect start at ${Math.round(state.debugClockHz / 1000000)} MHz.`)
    await processor.connect()
    appendLog("info", "DAP connect completed.")
  } catch (error) {
    appendLog("warn", `Initial probe connect failed, retrying: ${error.message}`)
    await sleep(100)
    await processor.reconnect()
    appendLog("info", "DAP reconnect completed.")
  }

  tuneCmsisDapProxy(processor)

  state.device = device
  state.transport = transport
  state.processor = processor
  state.probeLabel = `${device.productName || "CMSIS-DAP Probe"} (${formatUsbId(device)})`
  updateUi()
  return processor
}

function requestProbe() {
  appendLog("info", `Requesting WebUSB probe with ${REQUEST_FILTERS.length} filters.`)
  return navigator.usb.requestDevice({ filters: REQUEST_FILTERS })
}

async function connectRequestedProbe(devicePromise) {
  const chooserWatchdog = window.setTimeout(() => {
    appendLog("warn", "WebUSB chooser is still pending after 5 seconds.")
  }, 5000)

  try {
    const device = await devicePromise
    window.clearTimeout(chooserWatchdog)
    appendLog("info", `Chooser selected ${device.productName || "USB device"} (${formatUsbId(device)}).`)
    return connectDevice(device)
  } catch (error) {
    window.clearTimeout(chooserWatchdog)
    appendLog("error", `WebUSB chooser failed: ${error.message}`)
    throw error
  }
}

async function useAuthorizedProbe() {
  const devices = await navigator.usb.getDevices()
  appendLog("info", `Found ${devices.length} authorized WebUSB device(s).`)
  const device = devices.find(deviceMatches)
  if (!device) {
    throw new Error("No authorized CMSIS-DAP WebUSB device found.")
  }
  appendLog("info", `Using authorized probe ${device.productName || "USB device"} (${formatUsbId(device)}).`)
  return connectDevice(device)
}

async function ensureConnectedProbe(allowPrompt = true) {
  if (state.processor) {
    return state.processor
  }

  try {
    return await useAuthorizedProbe()
  } catch (error) {
    if (!allowPrompt) {
      throw error
    }
    return connectRequestedProbe(requestProbe())
  }
}

async function flashImage(processor, image) {
  const access = await ensureFlashAccess(processor)
  const programBlocks = buildProgramBlocks(image)
  appendLog("info", `Preparing ${image.name} (${image.programByteCount} programmed bytes).`)
  setStatus([
    `Image: ${image.name}`,
    `Address range: ${formatHex(image.firstAddress)} - ${formatHex(image.lastAddress)}`,
    `Program blocks: ${programBlocks.length}`,
    `SWD clock: ${Math.round(state.debugClockHz / 1000000)} MHz`,
    `Verify: ${state.verifyAfterFlash ? "on" : "off"}`,
    formatAccessState(access),
    "",
    "Resetting and halting target.",
  ])

  await resetAndHalt(processor)
  appendLog("info", "Target reset catch and halt completed.")

  appendLog("info", "Issuing chip erase.")
  setStatus([
    `Image: ${image.name}`,
    `Program blocks: ${programBlocks.length}`,
    "",
    "Erasing flash.",
  ])
  const accessAfterErase = await massEraseAndReconnect(processor, "chip erase")
  appendLog("info", `Chip erase complete. ${formatAccessState(accessAfterErase)}`)
  await resetAndHalt(processor)
  appendLog("info", "Using custom nRF54L15 flash stub runner.")
  await initFlashStub(processor)
  appendLog("info", `Using custom RAM flash stub (${FLASH_STUB.bufferBytes} byte blocks).`)

  let writtenBytes = 0
  updateProgress(0, image.programByteCount)

  try {
    for (let index = 0; index < programBlocks.length; index += 1) {
      const block = programBlocks[index]
      await programFlashBlock(processor, block)
      writtenBytes += block.words.length * 4
      updateProgress(writtenBytes, image.programByteCount)

      if (index === 0 || index === programBlocks.length - 1 || ((index + 1) % 8) === 0) {
        setStatus([
          `Image: ${image.name}`,
          `Program blocks: ${index + 1}/${programBlocks.length}`,
          `Current block: ${formatHex(block.address)} (${block.words.length * 4} bytes)`,
          `Progress: ${writtenBytes}/${image.programByteCount} bytes`,
          "",
          "Programming flash through RAM-resident RRAM copy stub.",
        ])
      }
    }
  } finally {
    try {
      await uninitFlashStub(processor)
    } catch (error) {
      appendLog("warn", `Flash stub shutdown failed: ${error.message}`)
    }
  }

  if (state.verifyAfterFlash) {
    await verifyImage(processor, image)
  } else {
    appendLog("info", "Skipping readback verify.")
  }
  await softResetAndRun(processor)
  appendLog("info", "Target reset after programming.")
}

async function runBusyTask(action) {
  if (state.busy) {
    return
  }
  state.busy = true
  updateUi()
  try {
    await action()
  } finally {
    state.busy = false
    updateUi()
  }
}

async function handleFileChange() {
  await runBusyTask(async () => {
    const file = ui.fileInput.files?.[0]
    if (!file) {
      state.image = null
      updateUi()
      return
    }

    try {
      state.image = await readSelectedImage(file)
      updateProgress(0, state.image.programByteCount)
      appendLog("info", `Loaded ${state.image.name} with ${state.image.chunks.length} chunks.`)
      setStatus([
        `Image: ${state.image.name}`,
        `Address range: ${formatHex(state.image.firstAddress)} - ${formatHex(state.image.lastAddress)}`,
        `Chunks: ${state.image.chunks.length}`,
        `Programmed bytes: ${state.image.programByteCount}`,
        `SWD clock: ${Math.round(state.debugClockHz / 1000000)} MHz`,
        `Verify: ${state.verifyAfterFlash ? "on" : "off"}`,
        "",
        "Image parsed successfully.",
      ])
      updateUi()
    } catch (error) {
      state.image = null
      updateProgress(0, 0)
      setProbeState("error", "Image Error")
      setStatus(error.message)
      appendLog("error", error.message)
      updateUi()
    }
  })
}

async function handleRequestProbe(devicePromise) {
  await runBusyTask(async () => {
    try {
      setProbeState("busy", "Requesting")
      setStatus("Waiting for the WebUSB chooser.")
      await connectRequestedProbe(devicePromise)
      const access = await readAccessState(state.processor)
      appendLog("info", `Connected ${state.probeLabel}. ${formatAccessState(access)}`)
      setProbeState("live", "Probe Ready")
      setStatus([
        `Connected: ${state.probeLabel}`,
        `SWD clock: ${Math.round(state.debugClockHz / 1000000)} MHz`,
        formatAccessState(access),
      ])
    } catch (error) {
      setProbeState("error", "Probe Error")
      setStatus(error.message)
      appendLog("error", error.message)
    }
  })
}

async function handleUseAuthorized() {
  await runBusyTask(async () => {
    try {
      setProbeState("busy", "Checking")
      await useAuthorizedProbe()
      const access = await readAccessState(state.processor)
      appendLog("info", `Connected ${state.probeLabel}. ${formatAccessState(access)}`)
      setProbeState("live", "Probe Ready")
      setStatus([
        `Connected: ${state.probeLabel}`,
        `SWD clock: ${Math.round(state.debugClockHz / 1000000)} MHz`,
        formatAccessState(access),
      ])
    } catch (error) {
      setProbeState("error", "Probe Error")
      setStatus(error.message)
      appendLog("error", error.message)
    }
  })
}

async function handleRecover() {
  await runBusyTask(async () => {
    try {
      setProbeState("busy", "Recovering")
      const processor = await ensureConnectedProbe(true)
      await recoverTarget(processor)
      setProbeState("live", "Recovered")
    } catch (error) {
      const snapshot = state.processor ? await getDebugSnapshot(state.processor) : "probe not connected"
      const detail = `${error.message}\n${snapshot}`
      setProbeState("error", "Recover Failed")
      setStatus(detail)
      appendLog("error", detail)
    }
  })
}

async function handleFlash() {
  await runBusyTask(async () => {
    if (!state.image) {
      setStatus("Choose a .hex file first.")
      return
    }

    try {
      setProbeState("busy", "Flashing")
      const processor = await ensureConnectedProbe(true)
      appendLog("info", `Starting flash for ${state.image.name}.`)
      await flashImage(processor, state.image)
      setProbeState("live", "Flash Complete")
      setStatus([
        `Image: ${state.image.name}`,
        `Address range: ${formatHex(state.image.firstAddress)} - ${formatHex(state.image.lastAddress)}`,
        `Programmed bytes: ${state.image.programByteCount}`,
        `SWD clock: ${Math.round(state.debugClockHz / 1000000)} MHz`,
        `Verify: ${state.verifyAfterFlash ? "on" : "off"}`,
        "",
        "Flash completed and target was reset.",
      ])
      updateProgress(state.image.programByteCount, state.image.programByteCount)
      appendLog("info", "Flash completed successfully.")
    } catch (error) {
      const snapshot = state.processor ? await getDebugSnapshot(state.processor) : "probe not connected"
      const detail = `${error.message}\n${snapshot}`
      setProbeState("error", "Flash Failed")
      setStatus(detail)
      appendLog("error", detail)
    }
  })
}

async function handleDisconnect() {
  await runBusyTask(async () => {
    await releaseProbe()
    setProbeState("idle", "Ready")
    setStatus("Probe disconnected.")
    appendLog("info", "Probe disconnected.")
  })
}

function bindEvents() {
  ui.fileInput.addEventListener("change", () => {
    void handleFileChange()
  })
  ui.requestProbe.addEventListener("click", () => {
    try {
      const devicePromise = requestProbe()
      void handleRequestProbe(devicePromise)
    } catch (error) {
      setProbeState("error", "Probe Error")
      setStatus(error.message)
      appendLog("error", error.message)
    }
  })
  ui.useAuthorized.addEventListener("click", () => {
    void handleUseAuthorized()
  })
  ui.recover.addEventListener("click", () => {
    void handleRecover()
  })
  ui.flash.addEventListener("click", () => {
    void handleFlash()
  })
  ui.disconnect.addEventListener("click", () => {
    void handleDisconnect()
  })
  ui.debugClockSelect.addEventListener("change", () => {
    const next = Number.parseInt(ui.debugClockSelect.value, 10)
    if (Number.isFinite(next) && next > 0) {
      state.debugClockHz = next
      ui.clockChip.textContent = `${Math.round(state.debugClockHz / 1000000)} MHz debug`
      appendLog("info", `SWD clock set to ${Math.round(state.debugClockHz / 1000000)} MHz.`)
      if (state.processor) {
        appendLog("warn", "Reconnect the probe to apply the new SWD clock.")
      }
      updateUi()
    }
  })
  ui.verifyToggle.addEventListener("change", () => {
    state.verifyAfterFlash = ui.verifyToggle.checked
    appendLog("info", `Verify after flash ${state.verifyAfterFlash ? "enabled" : "disabled"}.`)
    updateUi()
  })

  navigator.usb?.addEventListener?.("disconnect", (event) => {
    if (state.device && event.device === state.device) {
      appendLog("warn", "The CMSIS-DAP probe was unplugged.")
      void releaseProbe()
      setProbeState("error", "Probe Removed")
      setStatus("The connected CMSIS-DAP probe was disconnected.")
    }
  })
}

function installAutomationHooks() {
  window.__dapjsApp = {
    version: APP_BUILD_STAMP,
    async loadHexText(name, text) {
      state.image = parseIntelHex(text, name)
      updateProgress(0, state.image.programByteCount)
      appendLog("info", `Automation loaded ${state.image.name} with ${state.image.chunks.length} chunks.`)
      setStatus([
        `Image: ${state.image.name}`,
        `Address range: ${formatHex(state.image.firstAddress)} - ${formatHex(state.image.lastAddress)}`,
        `Chunks: ${state.image.chunks.length}`,
        `Programmed bytes: ${state.image.programByteCount}`,
        `SWD clock: ${Math.round(state.debugClockHz / 1000000)} MHz`,
        `Verify: ${state.verifyAfterFlash ? "on" : "off"}`,
        "",
        "Image parsed successfully.",
      ])
      updateUi()
      return {
        name: state.image.name,
        chunks: state.image.chunks.length,
        programByteCount: state.image.programByteCount,
      }
    },
    async useAuthorizedProbe() {
      await handleUseAuthorized()
      return this.getState()
    },
    async flash() {
      await handleFlash()
      return this.getState()
    },
    async recover() {
      await handleRecover()
      return this.getState()
    },
    async disconnect() {
      await handleDisconnect()
      return this.getState()
    },
    clearLogs() {
      state.logLines = []
      ui.log.textContent = ""
      return []
    },
    getLogs() {
      return [...state.logLines]
    },
    getState() {
      return {
        busy: state.busy,
        probeLabel: state.probeLabel,
        hasImage: !!state.image,
        imageName: state.image?.name ?? "",
        logCount: state.logLines.length,
        probeState: ui.probeState?.textContent ?? "",
        status: ui.status?.textContent ?? "",
      }
    },
  }
}

function bootstrap() {
  buildApp()
  bindEvents()
  installAutomationHooks()
  updateProgress(0, 0)
  appendLog("info", `App build ${APP_BUILD_STAMP}`)
  appendLog("info", "Transport: stock DAPjs.WebUSB / CortexM with short-read padding and conservative CMSIS-DAP batching. Flash path: custom nRF54L15 manual stub runner.")
  if ("usb" in navigator) {
    setProbeState("idle", "Ready")
    setStatus([
      "Choose a .hex image, connect a CMSIS-DAP probe, then recover or flash.",
      "",
      `SWD clock: ${Math.round(state.debugClockHz / 1000000)} MHz`,
      `Verify: ${state.verifyAfterFlash ? "on" : "off"}`,
    ])
  } else {
    setProbeState("error", "Unsupported")
    setStatus("This browser does not support WebUSB.")
  }
  updateUi()
}

bootstrap()
