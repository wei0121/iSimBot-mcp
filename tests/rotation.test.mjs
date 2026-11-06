import {test} from 'node:test';
import assert from 'node:assert/strict';
import{mkdtempSync,writeFileSync,readFileSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';import{join}from'node:path';
import{IDBClient}from'../dist/operation/idb-client.js';
import{tools}from'../dist/mcp/registry.js';
import{prepareSteps}from'../dist/common/operation.js';
import{parseOrientation}from'../dist/common/device-orientation.js';
import{registerScreenshot,mapScreenshotArguments,screenshotCoordinateEpoch,beginCoordinateChange,endCoordinateChange}from'../dist/image/screenshot-coordinates.js';
const result=()=>({content:[],structuredContent:{mode:'pixel',deviceInfo:{screenSize:{width:402,height:874},scale:3},imageSize:{width:1206,height:2622}}});
const register=client=>registerScreenshot(client,result(),{udid:client.getConnectedDevice(),scale:3}).structuredContent.screenshotId;

test('rotate publishes absolute orientations, supports chains and rejects bad input before any effect',async()=>{
 const tool=tools.find(t=>t.definition.name==='rotate'),calls=[];const client={rotate:async o=>calls.push(o)};
 for(const orientation of ['portrait','portrait_upside_down','landscape_left','landscape_right']){
  const response=await tool.execute(client,{orientation},{});assert.equal(response.success,true);assert.equal(response.orientation,orientation);
 }
 assert.equal(calls.length,4);
 for(const args of [{},{orientation:'left'},{orientation:'LANDSCAPE_LEFT'},{orientation:'portrait; touch /tmp/unsafe'},{orientation:'portrait',screenshotId:'stale'}]) await assert.rejects(tool.execute(client,args,{}));
 const chain=tools.find(t=>t.definition.name==='operation_chain');
 await assert.rejects(chain.execute(client,{steps:[{tool:'rotate',arguments:{orientation:'portrait'}},{tool:'rotate',arguments:{orientation:'wrong'}}]},{}));
 assert.equal(calls.length,4);
 const steps=prepareSteps([{tool:'rotate',arguments:{orientation:'portrait'},delay:0},{tool:'tap',arguments:{x:1,y:2}}],tools,'chain_11223344');
 assert.equal(steps[1].delay,1);
 assert.throws(()=>prepareSteps([{tool:'rotate',arguments:{orientation:'portrait'},delay:0},{tool:'tap',arguments:{x:1,y:2},delay:0.3}],tools,'chain_11223344'),e=>e.details.code==='MIN_OPERATION_DELAY');
 assert.equal(parseOrientation('{"orientation":"LANDSCAPE_RIGHT"}'),'landscape_right');
 assert.throws(()=>parseOrientation('{"orientation":"wrong"}'));
});

test('coordinate epochs invalidate old, in-flight and during-rotation image mappings on this client only',()=>{
 const a={getConnectedDevice:()=> 'a'},b={getConnectedDevice:()=> 'b'};
 const old=register(a),other=register(b),before=screenshotCoordinateEpoch(a);
 beginCoordinateChange(a);const during=screenshotCoordinateEpoch(a);assert.equal(during,null);
 assert.throws(()=>mapScreenshotArguments(a,{screenshotId:old,x:1,y:1}));
 const duringImage=registerScreenshot(a,result(),{udid:'a',scale:3});assert.equal(duringImage.structuredContent.screenshotId,undefined);
 endCoordinateChange(a);
 for(const epoch of[before,during])assert.equal(registerScreenshot(a,result(),{udid:'a',scale:3},epoch).structuredContent.screenshotId,undefined);
 assert.doesNotThrow(()=>mapScreenshotArguments(b,{screenshotId:other,x:3,y:3}));
 const fresh=register(a);assert.deepEqual(mapScreenshotArguments(a,{screenshotId:fresh,x:3,y:3}),{x:1,y:1});
});

test('rotate selects the device with literal argv, polls readback, invalidates references and reports backend failures',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'isimbot-rotate-')),oldPath=process.env.PATH;
 const log=join(dir,'args'),count=join(dir,'count'),mode=join(dir,'mode');
 writeFileSync(mode,'ok');
 writeFileSync(join(dir,'idb'),`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const mode=fs.readFileSync(${JSON.stringify(mode)},'utf8');if(mode==='fail'){process.stderr.write('unsupported rotation');process.exit(1);}
if(args.includes('--json')){let n=fs.existsSync(${JSON.stringify(count)})?Number(fs.readFileSync(${JSON.stringify(count)},'utf8')):0;fs.writeFileSync(${JSON.stringify(count)},String(n+1));console.log(mode==='invalid'?'not-json':JSON.stringify({orientation:n?'LANDSCAPE_LEFT':'UNKNOWN'}));}
`,{mode:0o755});process.env.PATH=`${dir}:${oldPath}`;
 t.after(()=>{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});});
 const client=new IDBClient();client.udid='selected-device';const old=register(client);
 await client.rotate('landscape_left');
 const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
 assert.deepEqual(calls,[['rotation','--udid','selected-device','--','LANDSCAPE_LEFT'],['rotation','--udid','selected-device','--json'],['rotation','--udid','selected-device','--json']]);
 assert.throws(()=>mapScreenshotArguments(client,{screenshotId:old,x:3,y:3}));
 const size=readFileSync(log,'utf8').length;await assert.rejects(client.rotate('$(whoami)'));assert.equal(readFileSync(log,'utf8').length,size);
 for(const failure of['fail','invalid']){
  const reference=register(client);writeFileSync(mode,failure);
  await assert.rejects(client.rotate('portrait'),e=>e.details.code==='ROTATION_FAILED');
  assert.throws(()=>mapScreenshotArguments(client,{screenshotId:reference,x:3,y:3}));assert.ok(register(client));
 }
 await assert.rejects(new IDBClient().rotate('portrait'),/deviceId/);
});

import sharp from 'sharp';
import{parseDisplayGeometry,hidPoint,parseHIDRotation}from'../dist/image/display-geometry.js';
import{processScreenshot}from'../dist/image/process-screenshot.js';
test('display geometry accepts all actual interface orientations and rejects invalid readback',()=>{
 for(const orientation of[1,2,3,4])assert.equal(parseDisplayGeometry(JSON.stringify({orientation,width:402,height:874})).orientation,orientation);
 for(const bad of[{orientation:0,width:402,height:874},{orientation:1,width:0,height:874},{orientation:1,width:402}])assert.throws(()=>parseDisplayGeometry(JSON.stringify(bad)));
});
test('pixel and logical images follow interface orientation with correct pixels, including inverted portrait',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'isimbot-rotation-image-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'native.png');
 const pixels=Buffer.alloc(4*6*3);for(let y=0;y<6;y++)for(let x=0;x<4;x++)pixels.set([x*30,y*30,100],(y*4+x)*3);
 await sharp(pixels,{raw:{width:4,height:6,channels:3}}).png().toFile(path);
 const corners={1:[0,0,100],2:[90,150,100],3:[90,0,100],4:[0,150,100]};
 for(const orientation of[1,2,3,4]){
  const geometry={udid:'device',scale:2,orientation};
  const image=await processScreenshot(path,{mode:'pixel',format:'png',quality:80,maxBytes:10000,maxSavedImages:200},geometry);
  assert.deepEqual(image.metadata.imageSize,orientation>=3?{width:6,height:4}:{width:4,height:6});
  const actual=await sharp(Buffer.from(image.data,'base64')).removeAlpha().raw().toBuffer();assert.deepEqual([...actual.subarray(0,3)],corners[orientation]);
  const logical=await processScreenshot(path,{mode:'logical',format:'png',quality:80,maxBytes:10000,maxSavedImages:200},geometry);
  assert.deepEqual(logical.metadata.imageSize,orientation>=3?{width:3,height:2}:{width:2,height:3});
 }
});
test('all gestures map interface points into confirmed idb display axes',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'isimbot-rotated-hid-')),oldPath=process.env.PATH,log=join(dir,'log');
 writeFileSync(join(dir,'idb'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));\n`,{mode:0o755});process.env.PATH=`${dir}:${oldPath}`;
 t.after(()=>{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});});
 const client=new IDBClient();client.udid='device';client.displayGeometry=async()=>({orientation:3,width:402,height:874,hidRotation:0});
 const args=()=>JSON.parse(readFileSync(log,'utf8'));
 for(const action of[()=>client.tap(100,50),()=>client.doubleTap(100,50),()=>client.longPress(100,50,1)]){await action();assert.deepEqual(args().slice(-2),['352','100']);}
 await client.swipe(100,50,200,100);assert.deepEqual(args().slice(-4),['352','100','302','200']);
 await client.scroll(100,100,'up',50);assert.deepEqual(args().slice(-4),['302','100','352','100']);
 await client.pinch(100,50,2,0.5,20);assert.deepEqual(args().slice(-3),['352','100','2']);
});

test('simulator screenshots retain reliable interface orientation and reject orientation changes or unavailable geometry',async t=>{
 const {existsSync}=await import('node:fs');
 if(!existsSync(new URL('../dist/native/isimbot-display',import.meta.url))){t.skip('Build simulator native tools for this integration test.');return;}
 const dir=mkdtempSync(join(tmpdir(),'isimbot-display-read-')),oldPath=process.env.PATH,mode=join(dir,'mode'),count=join(dir,'count');
 const png=join(dir,'fixture.png');await sharp({create:{width:4,height:6,channels:3,background:'white'}}).png().toFile(png);
 writeFileSync(mode,'stable');writeFileSync(count,'0');
 writeFileSync(join(dir,'xcrun'),`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),mode=fs.readFileSync(${JSON.stringify(mode)},'utf8');
if(args[0]!=='simctl'||args[1]!=='spawn'||!args[3].endsWith('isimbot-display'))process.exit(1);
if(mode==='bad'){console.log('bad-geometry');process.exit(0);}
const n=Number(fs.readFileSync(${JSON.stringify(count)},'utf8'));fs.writeFileSync(${JSON.stringify(count)},String(n+1));
console.log(JSON.stringify({width:2,height:3,orientation:mode==='change'&&n>0?4:3}));
`,{mode:0o755});
 writeFileSync(join(dir,'idb'),`#!${process.execPath}\nconst fs=require('node:fs');fs.copyFileSync(${JSON.stringify(png)},process.argv.at(-1));console.log('{"screen_scale":2}');\n`,{mode:0o755});
 process.env.PATH=`${dir}:${oldPath}`;t.after(()=>{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});});
 const client=new IDBClient();client.udid='11111111-2222-3333-4444-555555555555';const path=join(dir,'screen.png');
 await client.screenshot(path);assert.deepEqual(client.getScreenshotGeometry(path),{udid:client.udid,scale:2,orientation:3});
 writeFileSync(mode,'change');writeFileSync(count,'0');await assert.rejects(client.screenshot(path),e=>e.details.code==='DISPLAY_CHANGED_DURING_CAPTURE');assert.equal(client.getScreenshotGeometry(path),undefined);
 writeFileSync(mode,'bad');await assert.rejects(client.screenshot(path),e=>e.details.code==='DISPLAY_GEOMETRY_UNAVAILABLE');
});

test('HID mapping distinguishes app interface and Simulator window rotation, including locked interfaces',()=>{
 assert.deepEqual(hidPoint(201,437,{orientation:1,width:402,height:874,hidRotation:90}),[437,201]);
 assert.deepEqual(hidPoint(100,50,{orientation:3,width:402,height:874,hidRotation:270}),[100,50]);
 assert.deepEqual(hidPoint(100,50,{orientation:4,width:402,height:874,hidRotation:90}),[100,50]);
 assert.deepEqual(hidPoint(100,50,{orientation:2,width:402,height:874,hidRotation:180}),[100,50]);
 for(const orientation of[1,2,3,4])for(const hidRotation of[0,90,180,270]){
  const point=hidPoint(100,50,{orientation,width:402,height:874,hidRotation});assert.ok(point.every(Number.isFinite));
 }
 assert.throws(()=>hidPoint(1,1,{orientation:1,width:402,height:874}),/confirmed/);
 assert.throws(()=>hidPoint(10000,1,{orientation:1,width:402,height:874,hidRotation:0}),/outside/);
 assert.equal(parseHIDRotation(JSON.stringify({result:{displays:[{currentOrientation:'rot90',primary:true}]}})),90);
 assert.throws(()=>parseHIDRotation('{"result":{"displays":[]}}'));
});

test('integer-only idb HID commands round after coordinate transformation; pinch preserves floats',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'isimbot-hid-fractions-')),oldPath=process.env.PATH,log=join(dir,'log');
 writeFileSync(join(dir,'idb'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));\n`,{mode:0o755});process.env.PATH=`${dir}:${oldPath}`;
 t.after(()=>{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});});
 const client=new IDBClient();client.udid='device';client.displayGeometry=async()=>({orientation:3,width:402,height:874,hidRotation:0});
 const args=()=>JSON.parse(readFileSync(log,'utf8'));
 for(const action of[()=>client.tap(100.25,50.75),()=>client.doubleTap(100.25,50.75),()=>client.longPress(100.25,50.75,1)]){
  await action();assert.deepEqual(args().slice(-2),['351','100']);
 }
 await client.swipe(100.25,50.75,200.75,100.25);assert.deepEqual(args().slice(-4),['351','100','302','201']);
 await client.scroll(100.25,100.75,'up',50.5);assert.deepEqual(args().slice(-4),['301','100','352','100']);
 await client.pinch(100.25,50.75,2,0.5,20.5);assert.deepEqual(args().slice(-3),['351.25','100.25','2']);
});
