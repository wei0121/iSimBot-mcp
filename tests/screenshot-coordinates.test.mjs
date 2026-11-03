import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBClient } from '../dist/operation/idb-client.js';
import { registerScreenshot, clearScreenshotCoordinates } from '../dist/image/screenshot-coordinates.js';
import { gesturesTools } from '../dist/operation/gestures.js';
function register(client) {
  const result = registerScreenshot(client, { content: [], structuredContent: {mode:'pixel', deviceInfo:{screenSize:{width:402,height:874},scale:3},imageSize:{width:724,height:1573}} }, {udid:'device',scale:3});
  return result.structuredContent.screenshotId;
}
test('tap and swipe map screenshot pixels automatically; point calls remain unchanged', async () => {
  const client = new IDBClient(); client.udid = 'device';
  const screenshotId = register(client);
  const calls=[]; client.tap=async (...args)=>calls.push(args);client.swipe=async (...args)=>calls.push(args);
  const tap=gesturesTools.find(t=>t.definition.name==='tap');
  await tap.execute(client,{screenshotId,x:362,y:786.5},{});
  assert.deepEqual(calls.pop(),[201,437]);
  await tap.execute(client,{x:12,y:34},{});
  assert.deepEqual(calls.pop(),[12,34]);
  await gesturesTools.find(t=>t.definition.name==='swipe').execute(client,{screenshotId,x1:0,y1:0,x2:362,y2:786.5,duration:0.7},{});
  assert.deepEqual(calls.pop(),[0,0,201,437,0.7]);
  for (const args of [{screenshotId,x:724,y:2},{screenshotId:'missing',x:1,y:2}]) await assert.rejects(tap.execute(client,args,{}));
  client.udid='different';await assert.rejects(tap.execute(client,{screenshotId,x:1,y:2},{}));
  assert.equal(calls.length,0);
});
test('scroll converts distance on its axis, including the default, and rejects endpoints outside image', async () => {
  const client=new IDBClient();client.udid='device';const screenshotId=register(client);
  const calls=[];client.scroll=async (...args)=>calls.push(args);
  const scroll=gesturesTools.find(t=>t.definition.name==='scroll');
  await scroll.execute(client,{screenshotId,x1:362,y1:786.5,direction:'up'},{});
  const vertical=calls.pop(); assert.deepEqual(vertical.slice(0,3),[201,437,'up']); assert.ok(Math.abs(vertical[3]-200*874/1573)<1e-10);
  await scroll.execute(client,{screenshotId,x1:362,y1:786.5,direction:'right',distance:100},{});
  const horizontal=calls.pop(); assert.deepEqual(horizontal.slice(0,3),[201,437,'right']); assert.ok(Math.abs(horizontal[3]-100*402/724)<1e-10);
  await assert.rejects(scroll.execute(client,{screenshotId,x1:10,y1:10,direction:'up'},{}));
  assert.equal(calls.length,0);
});
test('references are bounded, expire, clear, and cannot cross server sessions', async () => {
  const client=new IDBClient();client.udid='device';client.tap=async()=>{};
  const tap=gesturesTools.find(t=>t.definition.name==='tap');
  const id=register(client);for(let i=0;i<20;i++)register(client);
  await assert.rejects(tap.execute(client,{screenshotId:id,x:1,y:1},{}));
  const current=register(client);const other=new IDBClient();other.udid='device';
  await assert.rejects(tap.execute(other,{screenshotId:current,x:1,y:1},{}));
  const now=Date.now;try{Date.now=()=>now()+300001;await assert.rejects(tap.execute(client,{screenshotId:current,x:1,y:1},{}));}finally{Date.now=now;}
  clearScreenshotCoordinates(client);await assert.rejects(tap.execute(client,{screenshotId:current,x:1,y:1},{}));
});
