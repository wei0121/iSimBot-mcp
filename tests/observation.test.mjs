import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateTouches, translateEditing, operationChain, parseObservationSnapshot, observationEvents } from '../dist/operation/observation-events.js';
import { tools } from '../dist/mcp/registry.js';
const event=(time,phase,x=10,y=20,id='one')=>({type:'touch',time,touches:[{id,phase,x,y,touchTime:time/1000,tapCount:1}]});

test('observation preserves actual paths and computes delay between touch starts',()=>{
 const events=[event(1000,0),event(1100,3),event(1900,0),event(2200,1,80,90),event(2500,3,150,200),event(3000,0),event(4000,3)];
 const gestures=translateTouches(events);
 assert.deepEqual(gestures.map(g=>g.tool),['tap','swipe','long_press']);
 assert.equal(gestures[1].points.length,3);
 const chain=operationChain(gestures);
 assert.deepEqual(chain.steps.map(s=>s.delay),[0,0.9,1.1]);
 assert.equal(chain.steps[1].arguments.duration,0.6);
 assert.equal(chain.steps[2].arguments.duration,1);
 assert.equal(chain.replayable,true);
});
test('cancelled, incomplete and multi-touch gestures are never fabricated as taps',()=>{
 const gestures=translateTouches([event(0,0),event(20,0,50,50,'two'),event(50,3),event(80,3,50,50,'two'),event(100,0),event(200,4),event(250,0)]);
 assert.equal(gestures.length,4);
 assert.ok(gestures.every(g=>g.type==='unsupported'));
 assert.equal(operationChain(gestures).replayable,false);
 assert.equal(operationChain(gestures).steps.length,0);
});
test('JSON snapshots validate handshake and every event timeline; timeline uses semantic types',()=>{
 const timeline='session_aabbccdd';
 const snapshot={timeline,handshake:{type:'ready',protocol:4,timeline,bundleId:'app.test'},samples:[{...event(1000,0),timeline},{...event(1100,3),timeline}]};
 assert.equal(parseObservationSnapshot(JSON.stringify(snapshot),timeline).samples.length,2);
 for(const bad of [ {...snapshot,timeline:'other'}, {...snapshot,handshake:{...snapshot.handshake,timeline:'other'}}, {...snapshot,samples:[{...snapshot.samples[0],timeline:'other'}]} ]) assert.throws(()=>parseObservationSnapshot(JSON.stringify(bad),timeline),/timeline/);
 assert.throws(()=>parseObservationSnapshot(JSON.stringify(snapshot).slice(0,-1),timeline));
 const events=observationEvents(translateTouches(snapshot.samples),[{type:'capture',captureIndex:0,startedAt:900,endedAt:950}],timeline,500);
 assert.deepEqual(events.map(e=>e.tool),['capture','tap']);
 assert.deepEqual(events.map(e=>e.time),[0.4,0.5]);
 assert.ok(events.every(e=>e.timeline===timeline));
 const chain=operationChain(translateTouches([event(0,0),event(100,3),event(20000,0),event(20100,3)]));
 assert.equal(chain.steps[1].delay,20);assert.equal(chain.replayable,false);
});
test('observation tools validate input and cannot be embedded in operation_chain',async()=>{
 const start=tools.find(t=>t.definition.name==='start_observation');
 await assert.rejects(start.execute({}, {bundleId:'test',captureInterval:0.1}, {}));
 const chain=tools.find(t=>t.definition.name==='operation_chain');
 await assert.rejects(chain.execute({}, {steps:[{tool:'start_observation',arguments:{bundleId:'test'}}]}, {}));
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ObservationStore } from '../dist/storage/observation-store.js';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';

test('observation lease, duplicate start, bounded image retrieval, cross-device isolation and auto-stop', {skip: !existsSync(new URL('../dist/native/isimbot-observer.dylib',import.meta.url))}, async t=>{
 const dir=mkdtempSync(join(tmpdir(),'isimbot-observation-test-'));
 const oldPath=process.env.PATH;
 const container=join(dir,'container');mkdirSync(container);
 writeFileSync(join(dir,'xcrun'),`#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2);
if(args[1]==='get_app_container')process.stdout.write(${JSON.stringify(container)});
if(args[1]==='launch'){
 const input=process.env.SIMCTL_CHILD_ISIMBOT_TEXT_INPUT_SESSION;
 if(input)fs.writeFileSync(path.join(${JSON.stringify(container)},'tmp','isimbot-input-'+input,'ready.json'),JSON.stringify({sessionId:input,bundleId:args[3],protocol:1,pid:process.pid}));
 const folder=path.join(${JSON.stringify(container)},'tmp','isimbot-observation-'+process.env.SIMCTL_CHILD_ISIMBOT_OBSERVATION_TIMELINE);
 const timeline=process.env.SIMCTL_CHILD_ISIMBOT_OBSERVATION_TIMELINE;
 fs.writeFileSync(path.join(folder,'samples.json'),JSON.stringify({timeline,handshake:{type:'ready',timeline,protocol:4,bundleId:args[3],time:Date.now()},samples:[]}));
}
`,{mode:0o755});
 process.env.PATH=`${dir}:${oldPath}`;
 const client={getConnectedDevice:()=> 'device-one',screenshot:async path=>{await sharp({create:{width:4,height:4,channels:3,background:'white'}}).png().toFile(path);return path;},getScreenshotGeometry:()=>({scale:1,udid:'device-one'}),describeUI:async()=> '[]'};
 const settings=new ScreenshotSettingsStore(join(dir,'settings.json'));
 const call=(name,args={})=>tools.find(t=>t.definition.name===name).execute(client,args,settings);
 t.after(async()=>{await call('stop_observation');process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});});
 const started=await call('start_observation',{bundleId:'dev.example.test',maxDuration:2});
 assert.equal(started.active,true);
 assert.ok(started.expireAt > Date.now() && started.expireAt <= Date.now()+2000);
 assert.equal(started.captureInterval,0.5);
 await assert.rejects(call('start_observation',{bundleId:'dev.example.test'}),/already active/);
 const source=join(container,'tmp',readdirSync(join(container,'tmp')).find(name=>name.startsWith('isimbot-observation-')));
 assert.equal(existsSync(join(source,'active')),true);
 await new Promise(r=>setTimeout(r,2400));
 assert.equal(existsSync(join(source,'active')),false);
 const result=await call('get_observation',{timeline:started.timeline,includeImages:true});
 assert.equal(result.structuredContent.active,false);
 const history=JSON.parse(readFileSync(join(started.directory,'observations.json'),'utf8'));
 const saved=history.find(s=>s.timeline===started.timeline);
 assert.ok(Array.isArray(history));
 assert.deepEqual(JSON.parse(readFileSync(join(started.directory,'observing.json'),'utf8')),[]);
 assert.ok(saved.events.some(e=>e.capture?.images.some(image=>existsSync(image.path))));
 assert.deepEqual(readdirSync(started.directory).sort(),['images','observations.json','observing.json']);
 assert.ok(Array.isArray(saved.events));
 assert.ok(!JSON.stringify(saved).includes('base64'));
 assert.ok(saved.events.filter(e=>e.capture).every(e=>!Object.hasOwn(e.capture,'content')));
 assert.ok(saved.events.every(e=>e.timeline===started.timeline && e.tool==='capture'));
 assert.deepEqual(saved.events.map(e=>e.index),saved.events.map((_,i)=>i));
 assert.ok(saved.events.every(e=>!Object.hasOwn(e,'captureIndex')));
 const last=saved.events.at(-1);
 assert.ok(Number(last.capture.images[0].path.match(/capture-(\d+)-/)[1])>last.index);
 assert.equal(saved.handshake.timeline,started.timeline);
 assert.equal(existsSync(join(started.directory,'events.jsonl')),false);
 assert.ok(Array.isArray(result.structuredContent.events));
 assert.ok(result.content.some(c=>c.type==='image'));
 assert.ok(result.content.filter(c=>c.type==='image').length<=2);
 await assert.rejects(tools.find(t=>t.definition.name==='get_observation').execute({getConnectedDevice:()=> 'device-two'},{timeline:started.timeline},settings),/different device/);
 await assert.rejects(call('get_observation',{timeline:'../../escape'}),/Invalid timeline/);
 assert.equal((await call('stop_observation')).active,false);
 const store=new ObservationStore(started.directory);
 const overdue=timeline=>({timeline,udid:'device-one',bundleId:'dev.example.test',startedAt:Date.now()-2000,expireAt:Date.now()-1000,captureInterval:0.5,events:[]});
 store.save(overdue('session_aaaa1111'),'observing');store.save(overdue('session_bbbb2222'),'observing');
 const second=await call('start_observation',{bundleId:'dev.example.test',maxDuration:30,captureInterval:1});
 assert.equal(second.captureInterval,1);
 assert.equal(store.lookup('session_aaaa1111').observing,false);
 assert.equal(store.lookup('session_bbbb2222').observing,false);
 store.save(overdue('session_cccc3333'),'observing');
 await call('get_observation',{timeline:started.timeline});
 assert.equal(store.lookup('session_cccc3333').observing,false);
 assert.equal(store.lookup(second.timeline).observing,true);
 assert.notEqual(second.timeline,started.timeline);
 const completed=await call('get_observation',{timeline:second.timeline});
 assert.equal(completed.structuredContent.active,false);
 assert.deepEqual(JSON.parse(readFileSync(join(second.directory,'observing.json'),'utf8')),[]);
 const archivedBefore=readFileSync(join(second.directory,'observations.json'),'utf8');
 await call('stop_observation');
 await call('get_observation',{timeline:second.timeline});
 assert.equal(readFileSync(join(second.directory,'observations.json'),'utf8'),archivedBefore);
 const third=await call('start_observation',{bundleId:'dev.example.test',maxDuration:30});
 assert.notEqual(third.timeline,second.timeline);
 await call('get_observation',{timeline:second.timeline});
 assert.ok(JSON.parse(readFileSync(join(third.directory,'observing.json'),'utf8')).some(s=>s.timeline===third.timeline));
 await call('stop_observation');
 assert.equal(JSON.parse(readFileSync(join(second.directory,'observations.json'),'utf8')).find(s=>s.timeline===second.timeline).captureInterval,1);
});

test('double tap requires UIKit count, nearby coordinates and timing, preserving interval to next action',()=>{
 const double=[event(0,0),event(80,3),event(200,0,12,21,'two'),event(280,3,12,21,'two')];
 double[2].touches[0].tapCount=2;double[3].touches[0].tapCount=2;
 const recorded=translateTouches([...double,event(1000,0),event(1100,3)]);
 assert.deepEqual(recorded.map(g=>g.tool),['double_tap','tap']);
 assert.equal(recorded[0].startedAt,0);assert.equal(recorded[0].endedAt,280);
 assert.equal(operationChain(recorded).steps[1].delay,1);
 const independent=structuredClone(double);independent[3].touches[0].tapCount=1;
 assert.deepEqual(translateTouches(independent).map(g=>g.tool),['tap','tap']);
 const distant=structuredClone(double);distant[2].touches[0].x=100;distant[3].touches[0].x=100;
 assert.deepEqual(translateTouches(distant).map(g=>g.tool),['tap','tap']);
 const delayed=structuredClone(double);delayed[2].time=800;delayed[3].time=880;
 assert.deepEqual(translateTouches(delayed).map(g=>g.tool),['tap','tap']);
});
test('scroll requires active scroll recognizer, distinguishes horizontal/vertical drags and ordinary swipe',()=>{
 const drag=[event(0,0,100,600),event(100,1,105,500),event(300,3,110,300)];
 const scroll=structuredClone(drag);scroll[1].touches[0].scrollViews=[{id:'list',panState:2,offsetX:0,offsetY:100}];
 const [gesture]=translateTouches(scroll);
 assert.equal(gesture.tool,'scroll');
 assert.deepEqual(gesture.arguments,{x1:100,y1:600,direction:'up',distance:300});
 assert.equal(operationChain([gesture]).replayable,true);
 assert.equal(translateTouches(drag)[0].tool,'swipe');
 const childDrag=structuredClone(drag);childDrag[1].touches[0].scrollViews=[{id:'list',panState:5,offsetX:0,offsetY:100}];
 assert.equal(translateTouches(childDrag)[0].tool,'swipe');
 const horizontal=[event(0,0,100,300),event(100,1,200,305),event(200,3,350,310)];
 horizontal[1].touches[0].scrollViews=[{id:'horizontal',panState:1,offsetX:40,offsetY:0}];
 assert.equal(translateTouches(horizontal)[0].arguments.direction,'right');
 assert.equal(translateTouches(horizontal)[0].arguments.distance,250);
});

test('observation event indexes span gestures and captures while private capture counters retain file identity',()=>{
 const timeline='session_aabbccdd';
 const gestures=translateTouches([event(1000,0),event(1600,3)]);
 const events=observationEvents(gestures,[{type:'capture',captureIndex:8,startedAt:900,endedAt:950},{type:'capture',captureIndex:9,startedAt:1200,endedAt:1250}],timeline,500);
 assert.deepEqual(events.map(e=>[e.index,e.tool,e.captureIndex]),[[0,'capture',8],[1,'long_press',undefined],[2,'capture',9]]);
});
