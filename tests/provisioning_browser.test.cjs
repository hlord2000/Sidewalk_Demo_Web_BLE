const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup({ allowed = true, provisioned = false, rejectWrite = false, changedBeforeWrite = false } = {}) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, style: {}, classList: { toggle() {} }, addEventListener() {}, append() {}, replaceChildren() {} });
    return elements.get(id);
  };
  const document = { getElementById: el, querySelector: el, querySelectorAll: () => [], createElement: el, addEventListener() {} };
  const window = { DEMO_CONFIG: { canProvisionFirmware: allowed, devices: [] }, location: { search: '' },
    setTimeout: (cb, ms) => setTimeout(cb, Math.min(ms, 20)), clearTimeout };
  const commands = [], requests = [], statuses = [];
  const device = { id: 1, name: 'New board', sidewalkSmsn: 'AB'.repeat(32), hasProvisioningArtifacts: true };
  const board = { transport: 'serial' };
  let reads = 0, finalized = false, finished = false;
  const fetch = async (url, opts = {}) => {
    requests.push(url);
    let result = { ok: true };
    if (url === '/api/provisioning/automatic') result.device = device;
    if (url.endsWith('/provisioning-script')) Object.assign(result, { valueCount: 1, commands: ['prov erase', 'prov set 4 1 0 AA==', 'prov finalize', 'prov reboot'] });
    if (url.endsWith('/provisioning-status')) statuses.push(JSON.parse(opts.body).status);
    return { ok: true, json: async () => result };
  };
  vm.runInNewContext(fs.readFileSync('static/provisioning.js', 'utf8'), { window, document, fetch, URLSearchParams, console });
  const api = window.SidewalkProvisioning;
  api.init({ currentDevice: () => null, registerDevice: async () => device,
    setBleLogDeviceId() {}, setBleWorkflowStatus() {}, readHardwareKey: async () => 'nrf54l15:test',
    connectedBoard: () => board, boardConnected: () => true, reconnectBoard: async () => {},
    finishAutomatic: async () => { finished = true; },
    sendBleCommand: async (command) => {
      commands.push(command);
      // Deliberately deliver each response BEFORE the send promise resolves.
      if (command === 'prov status') {
        reads++;
        api.ingestEvent({ t: 'prov', provisioned: provisioned || finalized || (changedBeforeWrite && reads > 1), smsn: device.sidewalkSmsn });
      }
      if (command.startsWith('prov set')) api.ingestEvent({ t: 'provwr', id: 4, ok: !rejectWrite });
      if (command === 'prov finalize') { finalized = true; api.ingestEvent({ t: 'provdone', ok: true }); }
    }
  });
  return { api, board, commands, requests, statuses, finished: () => finished };
}

test('blank device creates cloud records, accepts fast acknowledgments, and verifies after reboot', async () => {
  const s = setup();
  assert.equal(await s.api.autoProvisionConnected(s.board), true);
  assert.deepEqual(s.statuses, ['attempted', 'succeeded', 'verified']);
  assert.equal(s.finished(), true);
  assert.equal(s.commands.filter(c => c === 'prov erase').length, 1);
});
test('denied account performs no device writes or cloud requests', async () => {
  const s = setup({ allowed: false });
  assert.equal(await s.api.autoProvisionConnected(s.board), false);
  assert.deepEqual(s.commands, []);
  assert.deepEqual(s.requests, []);
});
test('already provisioned board is left intact without creating another device', async () => {
  const s = setup({ provisioned: true });
  assert.equal(await s.api.autoProvisionConnected(s.board), false);
  assert.deepEqual(s.commands, ['prov status']);
  assert.deepEqual(s.requests, []);
});
test('rechecks blank status before erasing after cloud creation', async () => {
  const s = setup({ changedBeforeWrite: true });
  await assert.rejects(s.api.autoProvisionConnected(s.board), /already provisioned/);
  assert.equal(s.commands.includes('prov erase'), false);
});
test('rejected credential aborts without finalize, reboot or verified status', async () => {
  const s = setup({ rejectWrite: true });
  await assert.rejects(s.api.autoProvisionConnected(s.board), /rejected/);
  assert.equal(s.commands.includes('prov finalize'), false);
  assert.equal(s.commands.includes('prov reboot'), false);
  assert.deepEqual(s.statuses, ['attempted', 'failed']);
});

test('first device activates the dashboard even when adding its option auto-selects it', async () => {
  const source = fs.readFileSync('static/app.js', 'utf8');
  const start = source.indexOf('async function registerProvisionedDevice(');
  const end = source.indexOf('function updateConnectedDeviceUi(', start);
  const selector = { value: '', disabled: true, add(option) { this.value = option.value; } };
  const config = { selectedDeviceId: null };
  let refreshed = false, subscribed = false;
  const context = vm.createContext({
    config, deviceSelector: selector, devices: [], deviceMap: new Map(), deviceByWirelessId: new Map(),
    document: { getElementById: () => null },
    Option: function(text, value) { this.text = text; this.value = value; },
    indexDeviceIdentity() {}, updateSelectedDeviceUi() { refreshed = true; },
    applySensorRange: async () => {}, connectEventStream() { subscribed = true; },
    URL, window: { location: { href: 'https://example.com/' }, history: { replaceState() {} } },
  });
  vm.runInContext(source.slice(start, end), context);
  await context.registerProvisionedDevice({ id: 123, name: 'First device', wirelessDeviceId: 'aws-123' });
  assert.equal(config.selectedDeviceId, 123);
  assert.equal(selector.disabled, false);
  assert.equal(refreshed, true);
  assert.equal(subscribed, true);
});
