import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { parseElements } from '../dist/operation/accessibility-elements.js';
import { tools } from '../dist/mcp/registry.js';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';
const element={AXLabel:'Share', AXUniqueId:'share', role:'AXButton',enabled:true,frame:{x:10,y:20,width:20,height:10}};
test('accessibility normalization preserves every node and duplicate, handles nested and missing frames',()=>{
 const elements=parseElements(JSON.stringify([{children:[element,element]},...Array(120).fill(element)]));
 assert.equal(elements.length,123);
 assert.equal(elements[0].center,null);
 assert.deepEqual(elements[1].center,{x:20,y:25});
 assert.equal(elements[1].identifier,'share');
 assert.deepEqual(parseElements('[]'),[]);
 for(const raw of ['null','bad','[null]','{"children":{}}']) assert.throws(()=>parseElements(raw),/accessibility/);
});
test('capture attaches elements, screenshot skips reading and uses native dimensions, chain supports both',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'isimbot-elements-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'source.png');await sharp({create:{width:120,height:240,channels:3,background:'#abc'}}).png().toFile(path);
 let reads=0;let failure=false;let empty=false;
 const client={getConnectedDevice:()=> 'device', getScreenshotGeometry:()=>({udid:'device',scale:3}),screenshot:async out=>{copyFileSync(path,out);return out;},describeUI:async()=>{reads++;if(failure)throw Error('unavailable');return JSON.stringify(empty?[]:[element]);}};
 client.captureScreen=async path=>{
  const startedAt=Date.now();const reads=await Promise.allSettled([client.screenshot(path),client.describeUI()]);
  if(reads[0].status==='rejected')throw reads[0].reason;
  return {path,timestamp:startedAt,captureTiming:{image:{startedAt,finishedAt:Date.now()},elements:{startedAt,finishedAt:Date.now()}},
   ...(reads[1].status==='fulfilled'?{elements:reads[1].value}:{elementsError:reads[1].reason.message})};
 };
 const settings=new ScreenshotSettingsStore(join(dir,'settings.json'));
 const tool=tools.find(t=>t.definition.name==='capture');
 const screenshot=tools.find(t=>t.definition.name==='screenshot');
 assert.ok(!tools.some(t=>t.definition.name==='find_elements'));
 for(const mode of ['logical','pixel','both']){
  const result=await tool.execute(client,{path:join(dir,'capture.png'),mode},settings);
  assert.equal(result.structuredContent.elements.length,1);
  assert.deepEqual(result.structuredContent.elements[0].center,{x:20,y:25});
  assert.equal(result.content.length,mode==='both'?2:1);
  if(mode==='both') for(const image of result.structuredContent.images) assert.ok(!('elements' in image));
 }
 assert.equal(reads,3);
 const skipped=await screenshot.execute(client,{},settings);
 assert.equal(skipped.structuredContent.mode,'pixel');
 assert.deepEqual(skipped.structuredContent.imageSize,{width:120,height:240});
 const defaultCapture=await tool.execute(client,{},settings);
 assert.equal(defaultCapture.structuredContent.mode,'logical');
 assert.deepEqual(defaultCapture.structuredContent.imageSize,{width:40,height:80});
 assert.ok(!('elements' in skipped.structuredContent));assert.equal(reads,4);
 await assert.rejects(tool.execute(client,{includeElements:'false'},settings),/Unknown/);
 failure=true;
 const failed=await tool.execute(client,{},settings);
 assert.equal(failed.structuredContent.elements,null);assert.match(failed.structuredContent.elementsError,/unavailable/);assert.equal(failed.content[0].type,'image');assert.ok(!failed.isError);
 failure=false;empty=true;
 assert.deepEqual((await tool.execute(client,{},settings)).structuredContent.elements,[]);
 const chain=tools.find(t=>t.definition.name==='operation_chain');
 const chained=await chain.execute(client,{steps:[{tool:'screenshot',interval:0},{tool:'capture',interval:0}]},settings);
 await assert.rejects(screenshot.execute(client,{includeElements:false},settings),/Unknown/);
 await assert.rejects(chain.execute(client,{steps:Array.from({length:31},(_,i)=>({tool:i%2?'capture':'screenshot',interval:0}))},settings),/30/);
 assert.ok(!('elements' in chained.structuredContent.events[0].result));
 assert.deepEqual(chained.structuredContent.events[1].elements,[]);
});
