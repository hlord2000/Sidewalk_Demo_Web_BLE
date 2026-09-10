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
