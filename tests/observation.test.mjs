import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateTouches, operationChain, parseObservationSnapshot, observationEvents } from '../dist/operation/observation-events.js';
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
test('JSON snapshots validate handshake and every event parentId; timeline uses semantic types',()=>{
 const parentId='session_aabbccdd';
 const snapshot={parentId,handshake:{type:'ready',protocol:3,parentId,bundleId:'app.test'},samples:[{...event(1000,0),parentId},{...event(1100,3),parentId}]};
 assert.equal(parseObservationSnapshot(JSON.stringify(snapshot),parentId).samples.length,2);
 for(const bad of [ {...snapshot,parentId:'other'}, {...snapshot,handshake:{...snapshot.handshake,parentId:'other'}}, {...snapshot,samples:[{...snapshot.samples[0],parentId:'other'}]} ]) assert.throws(()=>parseObservationSnapshot(JSON.stringify(bad),parentId),/parentId/);
 assert.throws(()=>parseObservationSnapshot(JSON.stringify(snapshot).slice(0,-1),parentId));
 const timeline=observationEvents(translateTouches(snapshot.samples),[{type:'capture',index:0,startedAt:900,endedAt:950}],parentId,500);
 assert.deepEqual(timeline.map(e=>e.tool),['capture','tap']);
 assert.deepEqual(timeline.map(e=>e.time),[0.4,0.5]);
 assert.ok(timeline.every(e=>e.parentId===parentId));
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
 const folder=path.join(${JSON.stringify(container)},'tmp','isimbot-observation-'+process.env.SIMCTL_CHILD_ISIMBOT_OBSERVATION_PARENT_ID);
 const parentId=process.env.SIMCTL_CHILD_ISIMBOT_OBSERVATION_PARENT_ID;
 fs.writeFileSync(path.join(folder,'samples.json'),JSON.stringify({parentId,handshake:{type:'ready',parentId,protocol:3,bundleId:args[3],time:Date.now()},samples:[]}));
}
`,{mode:0o755});
 process.env.PATH=`${dir}:${oldPath}`;
 const client={getConnectedDevice:()=> 'device-one',screenshot:async path=>{await sharp({create:{width:4,height:4,channels:3,background:'white'}}).png().toFile(path);return path;},getScreenshotGeometry:()=>({scale:1,udid:'device-one'}),describeUI:async()=> '[]'};
 const settings=new ScreenshotSettingsStore(join(dir,'settings.json'));
 const call=(name,args={})=>tools.find(t=>t.definition.name===name).execute(client,args,settings);
 t.after(async()=>{await call('stop_observation');process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});});
 const started=await call('start_observation',{bundleId:'dev.example.test',maxDuration:1});
 assert.equal(started.active,true);
 assert.equal(started.captureInterval,0.5);
 await assert.rejects(call('start_observation',{bundleId:'dev.example.test'}),/already active/);
 const source=join(container,'tmp',readdirSync(join(container,'tmp'))[0]);
 assert.equal(existsSync(join(source,'active')),true);
 await new Promise(r=>setTimeout(r,1400));
 assert.equal(existsSync(join(source,'active')),false);
 const result=await call('get_observation',{parentId:started.parentId,includeImages:true});
 assert.equal(result.structuredContent.active,false);
 const saved=JSON.parse(readFileSync(join(started.directory,'session.json'),'utf8'));
 assert.ok(Array.isArray(saved.events));
 assert.ok(saved.events.every(e=>e.parentId===started.parentId && e.tool==='capture'));
 assert.equal(saved.handshake.parentId,started.parentId);
 assert.equal(existsSync(join(started.directory,'events.jsonl')),false);
 assert.ok(Array.isArray(result.structuredContent.events));
 assert.ok(result.content.some(c=>c.type==='image'));
 assert.ok(result.content.filter(c=>c.type==='image').length<=2);
 await assert.rejects(tools.find(t=>t.definition.name==='get_observation').execute({getConnectedDevice:()=> 'device-two'},{parentId:started.parentId},settings),/different device/);
 await assert.rejects(call('get_observation',{parentId:'../../escape'}),/Invalid parentId/);
 assert.equal((await call('stop_observation')).active,false);
 const second=await call('start_observation',{bundleId:'dev.example.test',maxDuration:1,captureInterval:1});
 assert.equal(second.captureInterval,1);
 assert.notEqual(second.parentId,started.parentId);
 await call('stop_observation');
 assert.equal(JSON.parse(readFileSync(join(second.directory,'session.json'),'utf8')).captureInterval,1);
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
