import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IDBClient} from '../dist/operation/idb-client.js';
import {tools} from '../dist/mcp/registry.js';
import {registerScreenshot} from '../dist/image/screenshot-coordinates.js';

const pinch=tools.find(t=>t.definition.name==='pinch');
test('native pinch sends one command with both contacts handled by idb; errors never fall back',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'isimbot-native-pinch-')),log=join(dir,'args');
  const oldPath=process.env.PATH;t.after(()=>{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});});
  writeFileSync(join(dir,'idb'),`#!${process.execPath}\nimport('node:fs').then(fs=>{const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a.at(-1)==='0.5'){console.error('unsupported pinch backend');process.exitCode=1;}});\n`,{mode:0o755});
  process.env.PATH=`${dir}:${oldPath}`;
  const client=new IDBClient();client.udid='device';
  await client.pinch(201,437);
  await assert.rejects(client.pinch(201,437,0.5,1,80),/No swipe fallback/);
  const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls,[
    ['ui','pinch','--udid','device','--duration','0.5','--radius','100','--','201','437','2'],
    ['ui','pinch','--udid','device','--duration','1','--radius','80','--','201','437','0.5'],
  ]);
});
test('pinch converts screenshot center and radius, preserves scale/duration, and works in chains',async()=>{
  const client=new IDBClient();client.udid='device';const calls=[];client.pinch=async(...args)=>calls.push(args);
  const response=registerScreenshot(client,{content:[],structuredContent:{mode:'pixel',imageSize:{width:1206,height:2622},deviceInfo:{deviceId:'device',screenSize:{width:402,height:874},scale:3}}},{udid:'device',scale:3});
  const screenshotId=response.structuredContent.screenshotId;
  await pinch.execute(client,{screenshotId,x:603,y:1311,radius:210,scale:0.5,duration:1},{});
  assert.deepEqual(calls.pop(),[201,437,0.5,1,70]);
  await pinch.execute(client,{screenshotId,x:603,y:1311},{});
  const defaults=calls.pop();assert.deepEqual(defaults.slice(0,4),[201,437,2,0.5]);assert.ok(Math.abs(defaults[4]-100/3)<1e-10);
  const result=await tools.find(t=>t.definition.name==='operation_chain').execute(client,{steps:[{tool:'pinch',arguments:{x:201,y:437,scale:0.5},interval:0}]},{});
  assert.equal(result.structuredContent.success,true);assert.deepEqual(calls.pop(),[201,437,0.5,0.5,100]);
});
test('invalid pinch arguments fail before any action, including later chain steps',async()=>{
  const client={pinch:async()=>assert.fail('must not execute'),tap:async()=>assert.fail('must not execute')};
  for(const args of [{scale:0},{scale:Infinity},{scale:'2;echo bad'},{radius:0},{duration:-1},{x:-1}])await assert.rejects(pinch.execute(client,{x:200,y:400,...args},{}));
  await assert.rejects(tools.find(t=>t.definition.name==='operation_chain').execute(client,{steps:[{tool:'tap',arguments:{x:1,y:2},interval:0},{tool:'pinch',arguments:{x:1,y:2,radius:0},interval:0}]},{}));
});
