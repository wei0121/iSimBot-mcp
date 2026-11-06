import{test}from'node:test';import assert from'node:assert/strict';
import{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import sharp from'sharp';import{IDBClient}from'../dist/operation/idb-client.js';import{tools}from'../dist/mcp/registry.js';import{ScreenshotSettingsStore}from'../dist/setting/screenshot-settings.js';import{prepareSteps,withTimestampTiming}from'../dist/common/operation.js';import{createOperationChain}from'../dist/operation/operation-chain.js';import{ObservationStore}from'../dist/storage/observation-store.js';import{ChainCaptureStore}from'../dist/storage/chain-captures.js';import{parseObservationSnapshot,translateTouches}from'../dist/operation/observation-events.js';
const udid='11111111-1111-4111-8111-111111111111';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'isimbot-capture-time-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}

test('capture starts image and AX backend reads together before encoding; queued reads keep frame pairs together',async t=>{
 const dir=fixture(t),log=join(dir,'log'),png=join(dir,'source.png'),old=process.env.PATH;
 await sharp({create:{width:30,height:60,channels:3,background:'white'}}).png().toFile(png);
 writeFileSync(join(dir,'xcrun'),`#!${process.execPath}\nconsole.log(JSON.stringify({orientation:1,width:30,height:60}));`,{mode:0o755});
 writeFileSync(join(dir,'idb'),`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2),image=args[0]==='screenshot',kind=image?'image':'elements';const log=${JSON.stringify(log)};fs.appendFileSync(log,kind+'-start\\n');setTimeout(()=>{if(image){fs.copyFileSync(${JSON.stringify(png)},args.at(-1));console.log('{"screen_scale":1}');}else console.log('[{"AXLabel":"Current frame","type":"Button","frame":{"x":0,"y":0,"width":30,"height":20}}]');fs.appendFileSync(log,kind+'-end\\n');},100);`,{mode:0o755});
 process.env.PATH=dir+':'+old;t.after(()=>{process.env.PATH=old;});const client=new IDBClient();client.udid=udid;
 const settings=new ScreenshotSettingsStore(join(dir,'screenshot.json'));
 const result=await tools.find(t=>t.definition.name==='capture').execute(client,{},settings);
 const timing=result.structuredContent.captureTiming;assert.ok(Number.isSafeInteger(result.structuredContent.timestamp));assert.ok(result.structuredContent.timestamp>1700000000000);
 assert.ok(Math.abs(timing.image.startedAt-timing.elements.startedAt)<50);assert.ok(timing.image.finishedAt>=timing.elements.startedAt);assert.ok(timing.elements.finishedAt>=timing.image.startedAt);assert.equal(result.structuredContent.elements[0].label,'Current frame');
 let rows=readFileSync(log,'utf8').trim().split('\n');assert.ok(rows.indexOf('elements-start')<rows.indexOf('image-end'));assert.ok(rows.indexOf('image-start')<rows.indexOf('elements-end'));
 writeFileSync(log,'');await Promise.all([client.captureScreen(join(dir,'a.png')),client.captureScreen(join(dir,'b.png'))]);rows=readFileSync(log,'utf8').trim().split('\n');assert.deepEqual(rows.slice(0,4).sort(),['elements-end','elements-start','image-end','image-start']);assert.deepEqual(rows.slice(4).sort(),['elements-end','elements-start','image-end','image-start']);
});

test('chain timestamps use an epoch anchor while interval scheduling stays monotonic and seconds based',async()=>{
 let clock=0;const epoch=1794000000000;
 const tool={definition:{name:'tap',inputSchema:{type:'object',properties:{}}},execute:async()=>({success:true})};
 const chain=createOperationChain([tool],async ms=>{clock+=ms;},()=>clock,()=>epoch);
 const result=await chain.execute({}, {steps:[{tool:'tap',interval:0.5,timestamp:123},{tool:'tap',interval:0.4}]},{});
 assert.deepEqual(result.structuredContent.events.map(e=>e.timestamp),[epoch+500,epoch+900]);assert.deepEqual(result.structuredContent.events.map(e=>e.interval),[0.5,0.4]);assert.ok(result.structuredContent.events.every(e=>!Object.hasOwn(e,'time')));
 const recorded=withTimestampTiming([{tool:'tap',arguments:{},startedAt:epoch+50,endedAt:epoch+150}], 'session_12345678',epoch);assert.equal(recorded[0].timestamp,epoch+50);assert.equal(recorded[0].interval,0.05);assert.equal(recorded[0].duration,0.1);
});

test('chain accepts 100 operations, 30 captures and 120 seconds but rejects higher limits before dispatch',()=>{
 const parent='chain_12345678',tap={tool:'tap',arguments:{x:1,y:1},interval:0.4};
 assert.equal(prepareSteps(Array.from({length:100},()=>({...tap})),tools,parent).length,100);assert.throws(()=>prepareSteps(Array(101).fill(tap),tools,parent),/1–100/);
 assert.equal(prepareSteps(Array(30).fill({tool:'capture',interval:0}),tools,parent).length,30);assert.throws(()=>prepareSteps(Array(31).fill({tool:'capture',interval:0}),tools,parent),/30 screenshot/);
 assert.doesNotThrow(()=>prepareSteps(Array(12).fill({tool:'capture',interval:10}),tools,parent));assert.throws(()=>prepareSteps(Array(13).fill({tool:'capture',interval:10}),tools,parent),/120 seconds/);
});

test('legacy observation elapsed seconds normalize in memory; legacy chain timestamps stay unknown without guessing',t=>{
 const dir=fixture(t),epoch=1794000000000,timeline='session_12345678';
 const store=new ObservationStore(dir);writeFileSync(store.observationsPath,JSON.stringify([{timeline,udid:'device',bundleId:'app.test',startedAt:epoch,expireAt:epoch+1000,captureInterval:0.5,events:[{timeline,tool:'tap',arguments:{},time:0.5,interval:0.5,duration:0.1,points:[{x:1,y:2,time:epoch+500}]}]}]));
 const raw=readFileSync(store.observationsPath,'utf8');const event=store.find(timeline).events[0];assert.equal(event.timestamp,epoch+500);assert.equal(event.points[0].timestamp,epoch+500);assert.ok(!Object.hasOwn(event,'time'));assert.equal(readFileSync(store.observationsPath,'utf8'),raw);
 const chains=join(dir,'chains');mkdirSync(chains);const catalog=new ChainCaptureStore(chains);writeFileSync(catalog.path,JSON.stringify([{timeline:'chain_12345678',udid:'device',eventCount:1,captures:[{index:0,time:0.2,capture:{images:[]}}]}]));assert.equal(catalog.find('chain_12345678').captures[0].timestamp,null);
 const legacy={timeline,handshake:{type:'ready',protocol:5,timeline,bundleId:'app.test'},samples:[{type:'touch',timeline,time:epoch,touches:[{id:'x',phase:0,x:1,y:2,touchTime:1,tapCount:1}]}]};const parsed=parseObservationSnapshot(JSON.stringify(legacy),timeline);assert.equal(parsed.samples[0].timestamp,epoch);assert.equal(parsed.samples[0].touches[0].touchTimestamp,epoch);assert.ok(!Object.hasOwn(parsed.samples[0],'time'));
});


test('Observe uses actual touch epoch timestamps rather than later event dispatch timestamps',()=>{
 const epoch=1794000000000;
 const samples=[{type:'touch',timestamp:epoch+1000,touches:[{id:'a',phase:0,x:1,y:2,touchTimestamp:epoch,tapCount:1}]},
  {type:'touch',timestamp:epoch+2500,touches:[{id:'a',phase:3,x:1,y:2,touchTimestamp:epoch+200,tapCount:1}]}];
 const actions=translateTouches(samples);assert.equal(actions[0].tool,'tap');assert.equal(actions[0].startedAt,epoch);assert.equal(actions[0].endedAt,epoch+200);assert.deepEqual(actions[0].points.map(p=>p.timestamp),[epoch,epoch+200]);
});
