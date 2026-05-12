(() => {
  const fileInput = document.getElementById("firmware-file")
  const requestProbeButton = document.getElementById("firmware-request-probe")
  const authorizedProbeButton = document.getElementById("firmware-use-authorized")
  const recoverButton = document.getElementById("firmware-recover")
  const flashButton = document.getElementById("firmware-flash")
  const disconnectButton = document.getElementById("firmware-disconnect")
  const statusBox = document.getElementById("firmware-status")
  const logElement = document.getElementById("firmware-log")
  const probeStatus = document.getElementById("firmware-probe-status")
  const probeChip = document.getElementById("firmware-probe-chip")
  const imageChip = document.getElementById("firmware-image-chip")
  const progressChip = document.getElementById("firmware-progress-chip")

  if (!fileInput || !requestProbeButton || !authorizedProbeButton || !recoverButton || !flashButton || !disconnectButton) {
    return
  }

  const REQUEST_FILTERS = [
    { vendorId: 0x2886, productId: 0x0066 },
    { vendorId: 0x0d28 },
  ]

  const FLASH_ALGO = {
    loadAddress: 0x20000000,
    instructions: [
      0xE00ABE00,
      0xf8d24a02, 0x2b013400, 0x4770d1fb, 0x5004b000, 0x47702000, 0x47702000, 0x49072001, 0xf8c1b508,
      0xf7ff0500, 0xf8c1ffed, 0x20000540, 0xffe8f7ff, 0x0500f8c1, 0xbf00bd08, 0x5004b000, 0x2301b508,
      0xf8c14906, 0xf7ff3500, 0xf04fffdb, 0x600333ff, 0xf7ff2000, 0xf8c1ffd5, 0xbd080500, 0x5004b000,
      0x2301b538, 0x4d0c4614, 0x0103f021, 0x3500f8c5, 0xffc6f7ff, 0x44214622, 0x42911b00, 0x2000d105,
      0xffbef7ff, 0x0500f8c5, 0x4613bd38, 0x4b04f853, 0x461a5014, 0xbf00e7f1, 0x5004b000, 0x00000000
    ],
    pcInit: 0x20000015,
    pcUnInit: 0x20000019,
    pcEraseAll: 0x2000001d,
    pcProgramPage: 0x20000065,
    beginStack: 0x20000300,
    staticBase: 0x200000A4,
    programBuffer: 0x20001000,
    pageSize: 0x4,
    minProgramLength: 0x4,
    pageBuffers: [0x20001000, 0x20001004],
  }

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
    DFSR: 0xE000ED30,
    AIRCR: 0xE000ED0C,
    DHCSR: 0xE000EDF0,
    DEMCR: 0xE000EDFC,
  }

  const MASKS = {
    DBGKEY: 0xA05F0000,
    C_DEBUGEN: 0x00000001,
    C_HALT: 0x00000002,
    S_HALT: 0x00020000,
    DEMCR_VC_CORERESET: 0x00000001,
    AIRCR_VECTKEY: 0x05FA0000,
    AIRCR_SYSRESETREQ: 0x00000004,
    AIRCR_PRIGROUP_MASK: 0x00000700,
    XPSR_THUMB: 0x01000000,
    DFSR_CLEAR_ALL: 0x0000001F,
  }

  const FLASH_LIMITS = [
    { start: 0x00000000, end: 0x0017D000, label: "Application flash" },
    { start: 0x00FFD000, end: 0x00FFE000, label: "UICR" },
  ]

  const ACCESS_PORT = {
    AHB: 0,
    AUX_AHB: 1,
    CTRL: 2,
  }

  const ACCESS_PORT_REG = {
    CSW: 0x000,
    IDR: 0x0FC,
  }

  const CTRL_AP = {
    RESET: 0x000,
    ERASEALL: 0x004,
    ERASEALLSTATUS: 0x008,
    ERASEPROTECTSTATUS: 0x00C,
    APPROTECTSTATUS: 0x014,
    IDR: 0x0FC,
  }

  const CTRL_AP_STATUS = {
    READY: 0x0,
    READY_TO_RESET: 0x1,
    BUSY: 0x2,
    ERROR: 0x3,
  }

  const CTRL_AP_RESET_PULSE = 0x2
  const CTRL_AP_IDR_EXPECTED = 0x32880000
  const CSW_DEVICEEN = 0x00000040
  const MASS_ERASE_TIMEOUT_MS = 30000
  const IMAGE_CHUNK_BYTES = 4096
  const PROGRAM_PHRASE_BYTES = FLASH_ALGO.minProgramLength
  const DEBUG_CLOCK_HZ = 1000000

  const state = {
    busy: false,
    device: null,
    transport: null,
    processor: null,
    probeLabel: "",
    image: null,
  }

  function supportsUsb() {
    return typeof navigator !== "undefined" && "usb" in navigator && typeof window.DAPjs !== "undefined"
  }

  function setBadge(kind, text) {
    const className = kind === "error" ? "live-badge--error" : kind === "live" ? "live-badge--live" : "live-badge--connecting"
    probeStatus.className = `live-badge ${className}`
    probeStatus.textContent = text
  }

  function appendLog(level, message) {
    const timestamp = new Date().toLocaleTimeString()
    const card = document.createElement("article")
    card.className = "event-card event-card--fresh"
    card.textContent = `[${timestamp}] ${level.toUpperCase()}: ${message}`
    logElement.prepend(card)

    while (logElement.childElementCount > 18) {
      logElement.removeChild(logElement.lastElementChild)
    }
  }

  function setStatus(lines) {
    statusBox.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines)
  }

  function updateProgress(doneBytes, totalBytes) {
    if (!totalBytes) {
      progressChip.textContent = "Progress: 0%"
      return
    }
    const percent = Math.min(100, Math.round((doneBytes / totalBytes) * 100))
    progressChip.textContent = `Progress: ${percent}% (${doneBytes}/${totalBytes} bytes)`
  }

  function updateUi() {
    const connected = !!state.processor
    const hasImage = !!state.image
    const usbReady = supportsUsb()

    requestProbeButton.disabled = state.busy || !usbReady
    authorizedProbeButton.disabled = state.busy || !usbReady
    recoverButton.disabled = state.busy || !usbReady
    flashButton.disabled = state.busy || !usbReady || !hasImage
    disconnectButton.disabled = state.busy || !connected

    probeChip.textContent = state.probeLabel || "No probe connected"
    imageChip.textContent = state.image
      ? `${state.image.name} (${state.image.actualByteCount} data bytes, ${state.image.programByteCount} programmed bytes)`
      : "No image loaded"
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
  }

  function apRegister(apNumber, register) {
    return ((apNumber << 24) | register) >>> 0
  }

  function formatHex(value, width = 8) {
    return `0x${(value >>> 0).toString(16).padStart(width, "0")}`
  }

  function formatUsbId(device) {
    return `${formatHex(device.vendorId, 4)}:${formatHex(device.productId, 4)}`
  }

  function deviceMatches(device) {
    return (
      (device.vendorId === 0x2886 && device.productId === 0x0066) ||
      /CMSIS-DAP/i.test(device.productName || "")
    )
  }

  function wordsToBytes(words) {
    const bytes = new Uint8Array(words.length * 4)
    const view = new DataView(bytes.buffer)
    for (let index = 0; index < words.length; index++) {
      view.setUint32(index * 4, words[index] >>> 0, true)
    }
    return bytes
  }

  function bytesToWords(bytes) {
    const paddedLength = (bytes.length + 3) & ~3
    const padded = new Uint8Array(paddedLength)
    padded.fill(0xFF)
    padded.set(bytes)
    const view = new DataView(padded.buffer)
    const words = new Uint32Array(paddedLength / 4)
    for (let index = 0; index < words.length; index++) {
      words[index] = view.getUint32(index * 4, true)
    }
    return words
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

  function validateWordAddress(address) {
    for (const region of FLASH_LIMITS) {
      if (address >= region.start && (address + 4) <= region.end) {
        return
      }
    }
    throw new Error(`Image contains unsupported address ${formatHex(address)}`)
  }

  function parseIntelHex(text) {
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
      for (let index = 0; index < bytes.length; index++) {
        const value = Number.parseInt(record.slice(index * 2, index * 2 + 2), 16)
        if (!Number.isFinite(value)) {
          throw new Error(`Malformed Intel HEX byte in line: ${line}`)
        }
        bytes[index] = value
      }

      let checksum = 0
      for (const value of bytes) {
        checksum = (checksum + value) & 0xFF
      }
      if (checksum !== 0) {
        throw new Error(`Checksum mismatch in line: ${line}`)
      }

      const length = bytes[0]
      const offset = (bytes[1] << 8) | bytes[2]
      const type = bytes[3]
      const data = bytes.slice(4, 4 + length)

      if (data.length !== length) {
        throw new Error(`Truncated Intel HEX record: ${line}`)
      }

      if (type === 0x00) {
        const baseAddress = (upperAddress + offset) >>> 0
        for (let index = 0; index < data.length; index++) {
          const absoluteAddress = (baseAddress + index) >>> 0
          const wordAddress = absoluteAddress & ~0x3
          validateWordAddress(wordAddress)
          const shift = (absoluteAddress & 0x3) * 8
          const current = words.has(wordAddress) ? words.get(wordAddress) : 0xFFFFFFFF
          const updated = (current & ~(0xFF << shift)) | (data[index] << shift)
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
      name: fileInput.files && fileInput.files[0] ? fileInput.files[0].name : "image.hex",
      actualByteCount,
      programByteCount: addresses.length * 4,
      chunks,
      firstAddress: addresses[0],
      lastAddress: addresses[addresses.length - 1] + 4,
    }
  }

  async function readSelectedImage() {
    const file = fileInput.files && fileInput.files[0]
    if (!file) {
      throw new Error("Choose a .hex file first.")
    }
    const text = await file.text()
    const image = parseIntelHex(text)
    image.name = file.name
    return image
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

    await waitForHalt(
      processor,
      4000,
      "Timed out waiting for the target to halt during flash init."
    )

    await processor.writeMem32(DEBUG.DEMCR, oldDemcr)
    await processor.writeMem32(DEBUG.DFSR, MASKS.DFSR_CLEAR_ALL)
  }

  async function startFlashFunction(
    processor,
    pc,
    r0 = 0,
    r1 = 0,
    r2 = 0,
    r3 = 0,
    options = {},
  ) {
    const {
      ensureHalted = true,
      initContext = true,
    } = options

    if (ensureHalted) {
      await forceHalt(processor)
    }

    const commands = [
      processor.writeMem32Command(DEBUG.DFSR, MASKS.DFSR_CLEAR_ALL),
      processor.writeCoreRegisterCommand(CORE.R0, r0 >>> 0),
      processor.writeCoreRegisterCommand(CORE.R1, r1 >>> 0),
      processor.writeCoreRegisterCommand(CORE.R2, r2 >>> 0),
      processor.writeCoreRegisterCommand(CORE.R3, r3 >>> 0),
    ]

    if (initContext) {
      commands.push(
        processor.writeCoreRegisterCommand(CORE.R9, FLASH_ALGO.staticBase >>> 0),
        processor.writeCoreRegisterCommand(CORE.SP, FLASH_ALGO.beginStack >>> 0),
        processor.writeCoreRegisterCommand(CORE.PSR, MASKS.XPSR_THUMB),
      )
    }

    commands.push(
      processor.writeCoreRegisterCommand(CORE.LR, (FLASH_ALGO.loadAddress + 1) >>> 0),
      processor.writeCoreRegisterCommand(CORE.PC, pc >>> 0),
      processor.writeMem32Command(DEBUG.DHCSR, MASKS.DBGKEY | MASKS.C_DEBUGEN),
    )

    await processor.transferSequence(commands)
  }

  async function finishFlashFunction(processor, timeoutMs = 10000, message = "Timed out waiting for the flash algorithm to halt.") {
    await waitForHalt(processor, timeoutMs, message)
    const result = await processor.transferSequence([
      processor.readCoreRegisterCommand(CORE.R0),
    ])
    if (!(result[0] & 0x00010000)) {
      throw new Error("Register not ready")
    }
    return result[1] >>> 0
  }

  async function callFlashFunction(
    processor,
    pc,
    r0 = 0,
    r1 = 0,
    r2 = 0,
    r3 = 0,
    timeoutMs = 10000,
    options = {},
  ) {
    await startFlashFunction(processor, pc, r0, r1, r2, r3, options)
    return await finishFlashFunction(
      processor,
      timeoutMs,
      "Timed out waiting for the flash algorithm to halt.",
    )
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

  function formatAccessState(stateInfo) {
    return [
      `CTRL-AP IDR=${formatHex(stateInfo.ctrlApIdr)}`,
      `AHB-CSW=${formatHex(stateInfo.ahbCsw)}`,
      `APPROTECT=${formatHex(stateInfo.approtectStatus)}`,
      `ERASEPROTECT=${formatHex(stateInfo.eraseProtectStatus)}`,
    ].join(" ")
  }

  async function ensureFlashAccess(processor) {
    const access = await readAccessState(processor)

    if (!access.ctrlApOk) {
      appendLog("warn", `Unexpected CTRL-AP IDR. ${formatAccessState(access)}`)
    }

    if (!access.deviceEnabled) {
      throw new Error(`Target bus access is disabled. ${formatAccessState(access)}. Run Recover nRF54L15 and try again.`)
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

  async function recoverTarget(processor) {
    appendLog("warn", "Starting Nordic CTRL-AP recover sequence.")
    setStatus([
      "nRF54L15 recover",
      "",
      "Issuing Nordic CTRL-AP mass erase/unlock.",
    ])

    await processor.writeAP(apRegister(ACCESS_PORT.CTRL, CTRL_AP.ERASEALL), 1)
    await waitForCtrlApEraseStatus(
      processor,
      [CTRL_AP_STATUS.BUSY, CTRL_AP_STATUS.READY_TO_RESET],
      5000,
      "Mass erase did not start on the CTRL-AP."
    )
    await waitForCtrlApEraseStatus(
      processor,
      [CTRL_AP_STATUS.READY_TO_RESET],
      MASS_ERASE_TIMEOUT_MS,
      "Timed out waiting for CTRL-AP erase completion."
    )

    await sleep(10)
    await processor.writeAP(apRegister(ACCESS_PORT.CTRL, CTRL_AP.RESET), CTRL_AP_RESET_PULSE)
    await processor.writeAP(apRegister(ACCESS_PORT.CTRL, CTRL_AP.RESET), 0)
    await sleep(200)
    await processor.reconnect()

    const access = await ensureFlashAccess(processor)
    appendLog("info", `Recover complete. ${formatAccessState(access)}`)
    setStatus([
      "nRF54L15 recover complete.",
      formatAccessState(access),
    ])
  }

  async function verifyImage(processor, image) {
    appendLog("info", "Verifying programmed flash contents.")

    for (let index = 0; index < image.chunks.length; index++) {
      const chunk = image.chunks[index]
      const readBack = await processor.readBlock(chunk.address, chunk.words.length)

      for (let wordIndex = 0; wordIndex < chunk.words.length; wordIndex++) {
        const expected = chunk.words[wordIndex] >>> 0
        const actual = readBack[wordIndex] >>> 0

        if (actual !== expected) {
          throw new Error(
            `Verify failed at ${formatHex(chunk.address + (wordIndex * 4))}: expected ${formatHex(expected)} got ${formatHex(actual)}.`
          )
        }
      }

      if (index === 0 || index === image.chunks.length - 1 || ((index + 1) % 16) === 0) {
        setStatus([
          `Image: ${image.name}`,
          `Address range: ${formatHex(image.firstAddress)} - ${formatHex(image.lastAddress)}`,
          `Chunks verified: ${index + 1}/${image.chunks.length}`,
          "",
          "Verifying flash.",
        ])
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
          appendLog("warn", `Reset after flash session failed: ${error.message}`)
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

  async function connectDevice(device) {
    if (state.processor && state.device === device) {
      return state.processor
    }

    await releaseProbe()
    const transport = new window.DAPjs.WebUSB(device)
    const originalRead = transport.read.bind(transport)
    transport.read = async () => {
      const view = await originalRead()
      return padDataView(view, transport.packetSize || 64)
    }
    const processor = new window.DAPjs.CortexM(transport, 0, DEBUG_CLOCK_HZ)
    try {
      await processor.connect()
    } catch (error) {
      appendLog("warn", `Initial probe connect failed, retrying: ${error.message}`)
      await sleep(100)
      await processor.reconnect()
    }

    state.device = device
    state.transport = transport
    state.processor = processor
    state.probeLabel = `${device.productName || "CMSIS-DAP Probe"} (${formatUsbId(device)})`
    try {
      const access = await readAccessState(processor)
      appendLog("info", `Probe access: ${formatAccessState(access)}`)
    } catch (error) {
      appendLog("warn", `Connected probe, but target access check failed: ${error.message}`)
    }
    updateUi()
    return processor
  }

  async function requestProbe() {
    const device = await navigator.usb.requestDevice({ filters: REQUEST_FILTERS })
    return await connectDevice(device)
  }

  async function useAuthorizedProbe() {
    const devices = await navigator.usb.getDevices()
    const device = devices.find(deviceMatches)
    if (!device) {
      throw new Error("No authorized CMSIS-DAP WebUSB device was found.")
    }
    return await connectDevice(device)
  }

  async function ensureConnectedProbe(allowPrompt) {
    if (state.processor) {
      return state.processor
    }

    try {
      return await useAuthorizedProbe()
    } catch (error) {
      if (!allowPrompt) {
        throw error
      }
      return await requestProbe()
    }
  }

  async function flashImage(processor, image) {
    const access = await ensureFlashAccess(processor)
    appendLog("info", `Preparing ${image.name} (${image.programByteCount} programmed bytes).`)
    setStatus([
      `Image: ${image.name}`,
      `Address range: ${formatHex(image.firstAddress)} - ${formatHex(image.lastAddress)}`,
      `Chunks: ${image.chunks.length}`,
      formatAccessState(access),
      "",
      "Resetting and halting the target.",
    ])

    await resetAndHalt(processor)
    appendLog("info", "Target reset catch and halt completed.")

    await processor.writeBlock(FLASH_ALGO.loadAddress, new Uint32Array(FLASH_ALGO.instructions))
    appendLog("info", "Flash algorithm loaded into target RAM.")

    const eraseInitResult = await callFlashFunction(processor, FLASH_ALGO.pcInit, image.firstAddress, 0, 1, 0, 5000)
    if (eraseInitResult !== 0) {
      throw new Error(`Flash erase init failed with code ${eraseInitResult}.`)
    }

    setStatus([
      `Image: ${image.name}`,
      `Address range: ${formatHex(image.firstAddress)} - ${formatHex(image.lastAddress)}`,
      `Chunks: ${image.chunks.length}`,
      "",
      "Erasing flash.",
    ])
    appendLog("info", "Issuing chip erase.")
    const eraseResult = await callFlashFunction(processor, FLASH_ALGO.pcEraseAll, 0, 0, 0, 0, 30000)
    if (eraseResult !== 0) {
      throw new Error(`Flash erase failed with code ${eraseResult}.`)
    }

    const eraseUninitResult = await callFlashFunction(processor, FLASH_ALGO.pcUnInit, 1, 0, 0, 0, 5000)
    if (eraseUninitResult !== 0) {
      throw new Error(`Flash erase cleanup failed with code ${eraseUninitResult}.`)
    }

    const programInitResult = await callFlashFunction(processor, FLASH_ALGO.pcInit, image.firstAddress, 0, 2, 0, 5000)
    if (programInitResult !== 0) {
      throw new Error(`Flash program init failed with code ${programInitResult}.`)
    }

    let writtenBytes = 0
    updateProgress(0, image.programByteCount)

    for (let index = 0; index < image.chunks.length; index++) {
      const chunk = image.chunks[index]
      const chunkLength = chunk.words.length * 4

      if (chunk.words.length > 0) {
        let currentBufIndex = 0
        let nextBufIndex = 1

        await processor.writeBlock(
          FLASH_ALGO.pageBuffers[currentBufIndex],
          new Uint32Array([chunk.words[0] >>> 0]),
        )

        for (let wordIndex = 0; wordIndex < chunk.words.length; wordIndex++) {
          const phraseAddress = chunk.address + (wordIndex * 4)

          await startFlashFunction(
            processor,
            FLASH_ALGO.pcProgramPage,
            phraseAddress,
            PROGRAM_PHRASE_BYTES,
            FLASH_ALGO.pageBuffers[currentBufIndex],
            0,
            {
              ensureHalted: false,
              initContext: false,
            },
          )

          if (wordIndex + 1 < chunk.words.length) {
            await processor.writeBlock(
              FLASH_ALGO.pageBuffers[nextBufIndex],
              new Uint32Array([chunk.words[wordIndex + 1] >>> 0]),
            )
          }

          const programResult = await finishFlashFunction(
            processor,
            15000,
            "Timed out waiting for the flash algorithm to halt during program.",
          )
          if (programResult !== 0) {
            throw new Error(`Program phrase failed at ${formatHex(phraseAddress)} with code ${programResult}.`)
          }

          writtenBytes += PROGRAM_PHRASE_BYTES
          ;[currentBufIndex, nextBufIndex] = [nextBufIndex, currentBufIndex]
        }
      }

      updateProgress(writtenBytes, image.programByteCount)

      if (index === 0 || index === image.chunks.length - 1 || ((index + 1) % 16) === 0) {
        setStatus([
          `Image: ${image.name}`,
          `Address range: ${formatHex(image.firstAddress)} - ${formatHex(image.lastAddress)}`,
          `Chunks programmed: ${index + 1}/${image.chunks.length}`,
          `Current chunk: ${formatHex(chunk.address)} (${chunkLength} bytes)`,
          `Progress: ${writtenBytes}/${image.programByteCount} bytes`,
          "",
          "Programming flash.",
        ])
      }
    }

    const programUninitResult = await callFlashFunction(processor, FLASH_ALGO.pcUnInit, 2, 0, 0, 0, 5000)
    if (programUninitResult !== 0) {
      throw new Error(`Flash program cleanup failed with code ${programUninitResult}.`)
    }

    await verifyImage(processor, image)
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

  async function onFileChange() {
    await runBusyTask(async () => {
      try {
        state.image = await readSelectedImage()
        updateProgress(0, state.image.programByteCount)
        setStatus([
          `Image: ${state.image.name}`,
          `Address range: ${formatHex(state.image.firstAddress)} - ${formatHex(state.image.lastAddress)}`,
          `Chunks: ${state.image.chunks.length}`,
          `Programmed bytes: ${state.image.programByteCount}`,
          "",
          "Image parsed successfully.",
        ])
        appendLog("info", `Loaded ${state.image.name} with ${state.image.chunks.length} chunks.`)
        setBadge(state.processor ? "live" : "connecting", state.processor ? "Probe Ready" : "Image Ready")
      } catch (error) {
        state.image = null
        updateProgress(0, 0)
        setBadge("error", "Image Error")
        setStatus(error.message)
        appendLog("error", error.message)
      }
    })
  }

  async function onRequestProbe() {
    await runBusyTask(async () => {
      try {
        setBadge("connecting", "Requesting")
        setStatus("Waiting for the WebUSB chooser.")
        const processor = await requestProbe()
        setBadge("live", "Probe Ready")
        setStatus([
          `Connected: ${state.probeLabel}`,
          `Clock: ${DEBUG_CLOCK_HZ} Hz`,
          "",
          "Probe connection established.",
        ])
        appendLog("info", `Connected ${state.probeLabel}.`)
        return processor
      } catch (error) {
        setBadge("error", "Probe Error")
        setStatus(error.message)
        appendLog("error", error.message)
      }
    })
  }

  async function onUseAuthorizedProbe() {
    await runBusyTask(async () => {
      try {
        setBadge("connecting", "Checking")
        setStatus("Looking for an authorized CMSIS-DAP WebUSB device.")
        await useAuthorizedProbe()
        setBadge("live", "Probe Ready")
        setStatus([
          `Connected: ${state.probeLabel}`,
          `Clock: ${DEBUG_CLOCK_HZ} Hz`,
          "",
          "Authorized probe connection established.",
        ])
        appendLog("info", `Connected ${state.probeLabel} from prior WebUSB authorization.`)
      } catch (error) {
        setBadge("error", "Probe Error")
        setStatus(error.message)
        appendLog("error", error.message)
      }
    })
  }

  async function onFlash() {
    await runBusyTask(async () => {
      if (!state.image) {
        throw new Error("Choose a .hex file first.")
      }

      try {
        setBadge("connecting", "Connecting")
        const processor = await ensureConnectedProbe(true)
        setBadge("connecting", "Flashing")
        appendLog("info", `Starting flash for ${state.image.name}.`)
        await flashImage(processor, state.image)
        setBadge("live", "Flash Complete")
        setStatus([
          `Image: ${state.image.name}`,
          `Address range: ${formatHex(state.image.firstAddress)} - ${formatHex(state.image.lastAddress)}`,
          `Programmed bytes: ${state.image.programByteCount}`,
          "",
          "Flash completed and the target was reset to run the new firmware.",
        ])
        updateProgress(state.image.programByteCount, state.image.programByteCount)
        appendLog("info", "Flash completed successfully.")
      } catch (error) {
        const snapshot = state.processor ? await getDebugSnapshot(state.processor) : "probe not connected"
        const detail = `${error.message}\n${snapshot}`
        setBadge("error", "Flash Failed")
        setStatus(detail)
        appendLog("error", detail)
      }
    })
  }

  async function onRecover() {
    await runBusyTask(async () => {
      try {
        setBadge("connecting", "Recovering")
        const processor = await ensureConnectedProbe(true)
        await recoverTarget(processor)
        setBadge("live", "Recovered")
      } catch (error) {
        const snapshot = state.processor ? await getDebugSnapshot(state.processor) : "probe not connected"
        const detail = `${error.message}\n${snapshot}`
        setBadge("error", "Recover Failed")
        setStatus(detail)
        appendLog("error", detail)
      }
    })
  }

  async function onDisconnect() {
    await runBusyTask(async () => {
      await releaseProbe()
      setBadge("connecting", "Ready")
      setStatus("Probe disconnected.")
      appendLog("info", "Probe disconnected.")
    })
  }

  fileInput.addEventListener("change", () => {
    void onFileChange()
  })

  requestProbeButton.addEventListener("click", () => {
    void onRequestProbe()
  })

  authorizedProbeButton.addEventListener("click", () => {
    void onUseAuthorizedProbe()
  })

  recoverButton.addEventListener("click", () => {
    void onRecover()
  })

  flashButton.addEventListener("click", () => {
    void onFlash()
  })

  disconnectButton.addEventListener("click", () => {
    void onDisconnect()
  })

  if (supportsUsb()) {
    setBadge("connecting", "Ready")
    setStatus("Choose a .hex image, connect the CMSIS-DAP probe, then flash the nRF54L15.")
    updateProgress(0, 0)
  } else {
    setBadge("error", "Unsupported")
    setStatus("This browser needs WebUSB support and the DAPjs runtime to use CMSIS-DAP flashing.")
  }

  navigator.usb?.addEventListener?.("disconnect", (event) => {
    if (state.device && event.device === state.device) {
      appendLog("warn", "The CMSIS-DAP probe was unplugged.")
      void releaseProbe()
      setBadge("error", "Probe Removed")
      setStatus("The connected CMSIS-DAP probe was disconnected.")
    }
  })

  updateUi()
})()
