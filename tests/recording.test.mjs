import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ScreenRecording, recordingTools } from '../dist/operation/recording.js';
import { createOperationChain } from '../dist/operation/operation-chain.js';
import { DeviceManager } from '../dist/operation/device-manager.js';

function fixture(t, behavior = 'normal') {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-record-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const command = join(dir, 'xcrun');
  writeFileSync(command, `#!${process.execPath}
import fs from 'node:fs';
const out = process.argv.at(-1);
fs.writeFileSync(${JSON.stringify(join(dir,'args'))}, JSON.stringify(process.argv.slice(2)));
if (${JSON.stringify(behavior)} === 'early-exit') process.exit(2);
process.on('SIGINT', () => {
  if (${JSON.stringify(behavior)} === 'hang') return;
  setTimeout(() => { fs.writeFileSync(out, 'finalized-video'); process.exit(0); }, 40);
});
if (${JSON.stringify(behavior)} !== 'no-ready') setTimeout(() => process.stderr.write('Recording started\\n'), 30);
if (${JSON.stringify(behavior)} === 'crash') setTimeout(() => process.exit(3), 130);
setInterval(() => {}, 1000);
`, {mode:0o755});
  return {dir, command};
}

test('recording waits for first frame, sends exact device/codec args and waits for file finalization', async t => {
  const {dir,command}=fixture(t);
  const recording=new ScreenRecording('device-A',dir,300,{command});
  const started=await recording.start();
  assert.equal(started.status,'recording');
  assert.equal(existsSync(started.path),false);
  const args=JSON.parse(readFileSync(join(dir,'args')));
  assert.deepEqual(args.slice(0,-1), ['simctl','io','device-A','recordVideo','--codec=h264']);
  assert.notEqual(args.at(-1),started.path);
  const [a,b]=await Promise.all([recording.stop(),recording.stop()]);
  assert.equal(a.status,'saved');assert.equal(a.sizeBytes,15);assert.deepEqual(a,b);
  assert.equal(readFileSync(a.path,'utf8'),'finalized-video');
});

test('automatic stop preserves a retrievable completed result', async t => {
  const {dir,command}=fixture(t);
  const recording=new ScreenRecording('device-A',dir,0.05,{command});
  await recording.start();
  await new Promise(r=>setTimeout(r,160));
  assert.equal(recording.status().status,'saved');
  assert.equal((await recording.stop()).stopReason,'max_duration');
});

test('early failure, external exit, startup timeout and unresponsive stop report failure', async t => {
  for (const behavior of ['early-exit','crash','no-ready','hang']) {
    const {dir,command}=fixture(t,behavior);
    const recording=new ScreenRecording('device-A',dir,300,{command,startupTimeout:250,stopTimeout:80});
    const started=await recording.start();
    if (behavior==='crash') await new Promise(r=>setTimeout(r,180));
    const result=await recording.stop();
    assert.equal(result.success,false,behavior);
    assert.equal(result.status,'failed',behavior);
    if (behavior==='early-exit'||behavior==='no-ready') assert.equal(started.success,false);
  }
  const {dir}=fixture(t);
  const missing=new ScreenRecording('device-A',dir,300,{command:join(dir,'missing')});
  assert.equal((await missing.start()).success,false);
});

test('chain failure saves its recording, but never stops a pre-existing recording', async t => {
  const {dir}=fixture(t);const old=process.env.PATH;
  process.env.PATH=`${dir}:${old}`;t.after(()=>{process.env.PATH=old;});
  const client={getConnectedDevice:()=> 'device-A'};const settings={path:join(dir,'settings.json')};
  const fail={definition:{name:'fail',inputSchema:{type:'object',properties:{}}},execute:async()=>{throw Error('intentional');}};
  const chain=createOperationChain([...recordingTools,fail]);
  const result=await chain.execute(client,{steps:[{tool:'start_recording',delay:0},{tool:'fail',delay:0},{tool:'stop_recording',delay:0}]},settings);
  assert.equal(result.isError,true);assert.equal(result.structuredContent.recordingCleanup.status,'saved');
  assert.equal(result.structuredContent.recordingCleanup.stopReason,'chain_failed');
  const start=recordingTools.find(t=>t.definition.name==='start_recording');
  const stop=recordingTools.find(t=>t.definition.name==='stop_recording');
  const status=recordingTools.find(t=>t.definition.name==='recording_status');
  await start.execute(client,{},settings);
  await assert.rejects(start.execute(client,{},settings),/already/);
  await chain.execute(client,{steps:[{tool:'fail',delay:0}]},settings);
  assert.equal((await status.execute(client)).status,'recording');
  await stop.execute(client);
});

test('recording does not hold device queues; devices record independently and close saves both', async t => {
  const {dir}=fixture(t);const old=process.env.PATH;
  process.env.PATH=`${dir}:${old}`;t.after(()=>{process.env.PATH=old;});
  const clients=[];
  const manager=new DeviceManager({getConnectedDevice:()=>null,listDevices:async()=>['A','B'].map(udid=>({udid,name:udid,type:'simulator',state:'Booted'}))},()=>{
    const client={udid:null,connect:async function(id){this.udid=id;},getConnectedDevice(){return this.udid;}};
    clients.push(client);return client;
  });
  const settings={path:join(dir,'settings.json')};
  const start=recordingTools.find(t=>t.definition.name==='start_recording');
  const status=recordingTools.find(t=>t.definition.name==='recording_status');
  const results=await Promise.all(['A','B'].map(deviceId=>manager.execute(start,{deviceId},settings)));
  assert.notEqual(results[0].path,results[1].path);
  assert.equal(results[0].udid,'A'); assert.match(results[0].deviceId,/^[a-f0-9]{8}$/);
  let operated=false;
  await manager.execute({definition:{name:'test_operation',inputSchema:{type:'object',properties:{}}},execute:async()=>{operated=true;}},{deviceId:'A'},settings);
  assert.equal(operated,true);
  const chain = await manager.execute(createOperationChain(recordingTools), {deviceId:'A',steps:[{tool:'recording_status',delay:0}]},settings);
  assert.deepEqual(JSON.parse(chain.content[0].text).steps[0].result,chain.structuredContent.steps[0].result);
  await manager.close();
  for (const client of clients) {
    const result=await status.execute(client);
    assert.equal(result.status,'saved');assert.equal(result.stopReason,'server_shutdown');
  }
});


test('failed final transfer preserves a recovery file instead of claiming success', async t => {
  const {dir,command}=fixture(t);
  const directory=join(dir,'output');
  const recording=new ScreenRecording('device-A',directory,300,{command});
  await recording.start();
  renameSync(directory,join(dir,'moved-output'));
  writeFileSync(directory,'blocking file');
  const result=await recording.stop();
  assert.equal(result.success,false);
  assert.equal(result.status,'failed');
  assert.equal(readFileSync(result.recoveryPath,'utf8'),'finalized-video');
  rmSync(dirname(result.recoveryPath),{recursive:true,force:true});
});

test('MCP exposes recorder failures and finalizes on client disconnect', async t => {
  const {createServer}=await import('../dist/mcp/server.js');
  const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
  const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
  const {dir}=fixture(t); const old=process.env.PATH;
  process.env.PATH=`${dir}:${old}`;t.after(()=>{process.env.PATH=old;});
  const backend={getConnectedDevice:()=> 'device-A'};
  const server=createServer(backend,{path:join(dir,'settings.json')},()=>backend);
  const client=new Client({name:'recording-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  const response=await client.callTool({name:'start_recording',arguments:{}});
  const started=JSON.parse(response.content[0].text);
  assert.equal(started.status,'recording');
  const duplicate=await client.callTool({name:'start_recording',arguments:{}});
  assert.equal(duplicate.isError,true);
  const status=await client.callTool({name:'recording_status',arguments:{}});
  assert.equal(JSON.parse(status.content[0].text).status,'recording');
  await client.close();await server.close();
  assert.equal(readFileSync(started.path,'utf8'),'finalized-video');
});

test('chain accepts a custom recording path and still records to a temporary file first', async t => {
  const {dir}=fixture(t); const old=process.env.PATH;
  process.env.PATH=`${dir}:${old}`;t.after(()=>{process.env.PATH=old;});
  const client={getConnectedDevice:()=> 'device-A'};
  const path=join(dir,'custom folder','中文 video.mp4');
  const chain=createOperationChain(recordingTools);
  const result=await chain.execute(client,{steps:[
    {tool:'start_recording',arguments:{path},delay:0},
    {tool:'stop_recording',delay:0},
  ]},{path:join(dir,'config','settings.json')});
  assert.equal(result.structuredContent.success,true);
  assert.equal(result.structuredContent.steps[1].result.path,path);
  assert.equal(readFileSync(path,'utf8'),'finalized-video');
  assert.notEqual(JSON.parse(readFileSync(join(dir,'args'))).at(-1),path);
  assert.equal(existsSync(join(dir,'config','recordings')),false);
});

test('custom paths reject existing files and invalid paths; late collisions preserve both files', async t => {
  const {dir,command}=fixture(t);
  const path=join(dir,'existing.mp4');
  writeFileSync(path,'user video');
  assert.throws(()=>new ScreenRecording('A',dir,300,{command,path}),/already exists/);
  assert.equal(readFileSync(path,'utf8'),'user video');
  for (const bad of ['relative.mp4',join(dir,'video.mov'),'',join(dir,'bad\0.mp4')]) {
    assert.throws(()=>new ScreenRecording('A',dir,300,{command,path:bad}),/absolute .mp4/);
  }
  const racePath=join(dir,'race.mp4');
  const recording=new ScreenRecording('A',dir,300,{command,path:racePath});
  await recording.start();writeFileSync(racePath,'created during recording');
  const result=await recording.stop();
  assert.equal(result.success,false);
  assert.equal(readFileSync(racePath,'utf8'),'created during recording');
  assert.equal(readFileSync(result.recoveryPath,'utf8'),'finalized-video');
  rmSync(dirname(result.recoveryPath),{recursive:true,force:true});
});
