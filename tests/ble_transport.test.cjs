const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('static/app.js','utf8');
const send = source.slice(source.indexOf('function sendBleCommand(command)'),source.indexOf('\nif (downlinkForm)'));
function setup(properties = {write:true}) {
  const chunks=[];
  const characteristic={properties,
    async writeValueWithResponse(b){await new Promise(r=>setTimeout(r,1));chunks.push(['response',new TextDecoder().decode(b)]);},
    async writeValueWithoutResponse(b){chunks.push(['noresponse',new TextDecoder().decode(b)]);}};
  const ctx=vm.createContext({bleTransportGeneration:0,serialBoard:null,bleRxCharacteristic:characteristic,bleConnectedProfile:{textShell:true},bleWriteQueue:Promise.resolve(),textEncoder:new TextEncoder()});
  vm.runInContext(send,ctx);
  return {ctx,chunks};
}
test('simultaneous long commands stay complete and use acknowledged 20-byte writes',async()=>{
 const {ctx,chunks}=setup();const a='x'.repeat(61),b='mflt info';
 await Promise.all([ctx.sendBleCommand(a),ctx.sendBleCommand(b)]);
 assert.equal(chunks.map(x=>x[1]).join(''),a+'\n'+b+'\n');
 assert.ok(chunks.every(x=>x[0]==='response'&&x[1].length<=20));
});
test('write mode follows characteristic properties despite both methods existing',async()=>{
 const {ctx,chunks}=setup({writeWithoutResponse:true});await ctx.sendBleCommand('status');assert.equal(chunks[0][0],'noresponse');
});
test('disconnect cancels queued commands instead of sending to the next board',async()=>{
 const {ctx,chunks}=setup();const pending=ctx.sendBleCommand('prov erase');ctx.bleTransportGeneration++;
 await assert.rejects(pending,/cancelled/);assert.equal(chunks.length,0);
 await ctx.sendBleCommand('prov status');assert.equal(chunks.length,1);
});
test('a failed write does not poison subsequent commands',async()=>{
 const {ctx,chunks}=setup({});await assert.rejects(ctx.sendBleCommand('status'),/not writable/);
 ctx.bleRxCharacteristic.properties={write:true};await ctx.sendBleCommand('mflt info');assert.equal(chunks.length,1);
});
test('USB commands share the line queue without simultaneous writer locks',async()=>{
 const {ctx}=setup();let locked=false;const lines=[];
 ctx.serialBoard={port:{writable:{getWriter(){assert.equal(locked,false);locked=true;return {async write(b){await new Promise(r=>setTimeout(r,1));lines.push(new TextDecoder().decode(b));},releaseLock(){locked=false;}};}}}};
 await Promise.all([ctx.sendBleCommand('one'),ctx.sendBleCommand('two')]);assert.deepEqual(lines,['one\n','two\n']);
});
test('chooser opens synchronously without awaiting device identity requests',async()=>{
 const code=source.slice(source.indexOf('async function connectBleShellImpl('),source.indexOf('\nasync function disconnectBleShell'));
 let requested=false;const ctx=vm.createContext({window:{},navigator:{bluetooth:{requestDevice(){requested=true;throw new Error('chooser reached');}}},stopBleNearbyScan(){},config:{canProvisionFirmware:true},currentDevice:()=>({name:'Test'}),bleDebug(){},setBleStatus(){},BLE_PROFILES:[{serviceUuid:'nus'}]});
 vm.runInContext(code,ctx);const pending=ctx.connectBleShellImpl();assert.equal(requested,true);await assert.rejects(pending,/chooser reached/);
});

const discoverySource=source.slice(source.indexOf('async function discoverBleShell('),source.indexOf('async function connectBleShell(source'));
function discoverySetup({failures=1,permanent=false}={}) {
 let attempts=0;const delays=[];const rx={uuid:'rx'},tx={uuid:'tx'};
 const board={name:'Sidewalk',gatt:{connected:false,disconnect(){this.connected=false;},async connect(){attempts++;this.connected=true;return this;},async getPrimaryService(){
  if(attempts<=failures){this.connected=permanent;const e=new Error(permanent?'Service not found':'GATT Server is disconnected');e.name=permanent?'NotFoundError':'NetworkError';throw e;}
  return{async getCharacteristic(uuid){return uuid==='rx'?rx:tx;}};
 }}};
 const ctx=vm.createContext({setTimeout});vm.runInContext(discoverySource,ctx);
 return {board,attempts:()=>attempts,delays,run:(extra={})=>ctx.discoverBleShell(board,{serviceUuid:'nus',writeUuid:'rx',notifyUuid:'tx'},{delay:async ms=>delays.push(ms),...extra})};
}
test('discovery reconnects the chosen board after a dropped first connection',async()=>{
 const s=discoverySetup();const result=await s.run();assert.equal(s.attempts(),2);assert.equal(result.rx.uuid,'rx');assert.deepEqual(s.delays,[600]);
});
test('persistent connection drops stop after three attempts',async()=>{
 const s=discoverySetup({failures:10});await assert.rejects(s.run(),/after 3 attempts/);assert.equal(s.attempts(),3);
});
test('missing UART service on a connected device does not trigger retries',async()=>{
 const s=discoverySetup({permanent:true});await assert.rejects(s.run(),/Service not found/);assert.equal(s.attempts(),1);
});
test('user cancellation during retry backoff prevents another connection',async()=>{
 const s=discoverySetup();let cancelled=false;
 await assert.rejects(s.run({check(){if(cancelled)throw new Error('cancelled');},delay:async()=>{cancelled=true;}}),/cancelled/);assert.equal(s.attempts(),1);
});
