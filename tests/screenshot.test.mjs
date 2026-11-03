import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { ScreenshotSettingsStore, defaults } from '../dist/setting/screenshot-settings.js';
import { screenshotResult } from '../dist/mcp/screenshot-response.js';
import { createServer } from '../dist/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'isimbot-image-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('settings reads are side-effect free; updates persist; invalid settings do not overwrite', t => {
  const path = join(fixture(t), 'screenshot.json');
  const store = new ScreenshotSettingsStore(path);
  assert.deepEqual(store.update({}), defaults);
  assert.equal(existsSync(path), false);
  store.update({ mode: 'pixel' });
  assert.equal(new ScreenshotSettingsStore(path).read().mode, 'pixel');
  const original = readFileSync(path, 'utf8');
  for (const patch of [{ scale: 0 }, { scale: 5 }, { scale: '2x' }, { maxWidth: 100 }, { format: 'gif' }, { quality: 3 }, { maxBytes: -1 }, { maxSavedImages: 0 }, { maxSavedImages: 1.5 }, { maxSavedImages: 10001 }]) {
    assert.throws(() => store.update(patch));
    assert.equal(readFileSync(path, 'utf8'), original);
  }
  writeFileSync(path, 'broken');
  assert.throws(() => store.update({ scale: 2 }));
  assert.equal(readFileSync(path, 'utf8'), 'broken');
});
test('logical, pixel and both preserve exact dimensions and original; missing geometry fails logical', async t => {
  const path = join(fixture(t), 'original.png');
  await sharp({ create: { width: 1206, height: 2622, channels: 3, background: '#abcdef' } }).png().toFile(path);
  const original = readFileSync(path);
  for (const mode of ['logical', 'pixel', 'both']) {
    const result = await screenshotResult(path, { ...defaults, mode }, {udid:'device',scale:3});
    const modes = mode === 'both' ? ['logical','pixel'] : [mode];
    assert.equal(result.content.length, modes.length);
    for (const [i, expected] of modes.entries()) {
      const entry=mode==='both'?result.structuredContent.images[i]:result.structuredContent;
      const metadata=entry.deviceInfo;
      const image=result.content[i];
      const decoded=await sharp(Buffer.from(image.data,'base64')).metadata();
      assert.equal(entry.mode, expected);
      assert.equal(decoded.width, expected==='logical'?402:1206);
      assert.equal(decoded.height, expected==='logical'?874:2622);
      assert.deepEqual(metadata.screenSize,{width:402,height:874});
      assert.deepEqual(entry.imageSize,{width:decoded.width,height:decoded.height});
      assert.deepEqual(Object.keys(metadata).sort(),['deviceId','scale','screenSize']);
      assert.equal(metadata.scale,3);
    }
    assert.deepEqual(readFileSync(path),original);
  }
  await assert.rejects(screenshotResult(path,defaults), /logical image/);
  const pixel=await screenshotResult(path,{...defaults,mode:'pixel'});
  assert.equal(pixel.structuredContent.deviceInfo.screenSize,null);
});
test('legacy scale migrates without changing the file', t => {
  const path=join(fixture(t),'settings.json');
  const text=JSON.stringify({scale:0.6,maxBytes:2000000,quality:70,maxSavedImages:17});
  writeFileSync(path,text);
  const store=new ScreenshotSettingsStore(path);
  assert.deepEqual(store.read(),{...defaults,quality:70,maxSavedImages:17});
  assert.equal(readFileSync(path,'utf8'),text);
  assert.throws(()=>store.update({scale:0.6}));
});
test('byte cap fails explicitly instead of changing dimensions; JPEG returns valid bytes', async t => {
  const path = join(fixture(t), 'noise.png');
  await sharp(randomBytes(200 * 400 * 3), { raw: { width: 200, height: 400, channels: 3 } }).png().toFile(path);
  await assert.rejects(screenshotResult(path, { ...defaults, mode: 'pixel', maxBytes: 10000 }), /requested dimensions/);
  const result = await screenshotResult(path, { ...defaults, mode: 'pixel', format: 'jpeg' });
  assert.equal(result.content[0].mimeType, 'image/jpeg');
  assert.equal((await sharp(Buffer.from(result.content[0].data, 'base64')).metadata()).format, 'jpeg');
});
test('MCP setup configures subsequent image responses, survives server recreation, propagates errors', async t => {
  const dir = fixture(t);
  const path = join(dir, 'screen.png');
  const settingsPath = join(dir, 'settings.json');
  await sharp({ create: { width: 200, height: 400, channels: 3, background: 'white' } }).png().toFile(path);
  const fake = { getConnectedDevice:()=> 'device', getScreenshotGeometry: () => ({udid:'device',scale:2}), screenshot: async output => { copyFileSync(path, output); return output; } };
  for (const restart of [false, true]) {
    const server = createServer(fake, new ScreenshotSettingsStore(settingsPath));
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      const response = await client.callTool({ name: 'setup', arguments: restart ? {} : { mode: 'logical' } });
      assert.equal(JSON.parse(response.content[0].text).configuration.mode, 'logical');
      const image = await client.callTool({ name: 'capture', arguments: {} });
      const native = await client.callTool({ name: 'screenshot', arguments: {} });
      assert.equal(native.structuredContent.imageSize.width, 200);
      assert.ok(!('elements' in native.structuredContent));
      assert.equal(image.content[0].type, 'image');
      assert.equal(image.structuredContent.imageSize.width, 100);
      const bad = await client.callTool({ name: 'setup', arguments: { scale: -1 } });
      assert.equal(bad.isError, true);
    } finally { await client.close(); await server.close(); }
  }
});

test('per-call screenshot overrides, actionable errors and chain validation preserve saved settings', async t => {
  const dir = fixture(t);
  const source = join(dir, 'noise.png');
  await sharp(randomBytes(200 * 400 * 3), { raw: { width: 200, height: 400, channels: 3 } }).png().toFile(source);
  const store = new ScreenshotSettingsStore(join(dir, 'settings.json'));
  assert.equal(store.read().mode, 'logical');
  assert.equal(store.read().maxBytes, 5000000);
  store.update({ mode: 'pixel' });
  const originalSettings = readFileSync(store.path, 'utf8');
  let captures = 0;
  const fake = { getConnectedDevice:()=> 'device', getScreenshotGeometry: () => ({udid:'device',scale:2}), screenshot: async output => { captures++; copyFileSync(source, output); return output; } };
  const server = createServer(fake, store);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const override = await client.callTool({ name: 'screenshot', arguments: { mode: 'logical', format: 'jpeg', quality: 60, maxBytes: 2000000 } });
    assert.equal(override.content[0].mimeType, 'image/jpeg');
    assert.equal(override.structuredContent.imageSize.width, 100);
    const next = await client.callTool({ name: 'screenshot', arguments: {} });
    assert.equal(next.structuredContent.imageSize.width, 200);
    const bad = await client.callTool({ name: 'screenshot', arguments: { mode: 'pixel', maxBytes: 10000 } });
    assert.equal(bad.isError, true);
    const error = JSON.parse(bad.content[0].text);
    assert.equal(error.code, 'SCREENSHOT_TOO_LARGE');
    assert.ok(error.actualBytes > error.maxBytes);
    assert.equal(error.allowedMaxBytes.maximum, 5000000);
    const retried = await client.callTool({ name: error.retry.tool, arguments: error.retry.arguments });
    assert.ok(!retried.isError);
    const chain = await client.callTool({ name: 'operation_chain', arguments: { steps: [
      { tool: 'screenshot', arguments: { mode: 'logical', quality: 60, maxBytes: 2000000 }, delay: 0 },
      { tool: 'screenshot', arguments: { mode: 'pixel', maxBytes: 10000 }, delay: 0 },
    ] } });
    assert.equal(JSON.parse(chain.content[0].text).steps[1].code, 'SCREENSHOT_TOO_LARGE');
    const before = captures;
    const invalid = await client.callTool({ name: 'operation_chain', arguments: { steps: [
      { tool: 'screenshot', delay: 0 },
      { tool: 'screenshot', arguments: { maxBytes: 9000000 }, delay: 0 },
    ] } });
    assert.equal(invalid.isError, true);
    assert.equal(captures, before);
    const invalidSetting = await client.callTool({ name: 'setup', arguments: { maxBytes: 9000000 } });
    assert.match(JSON.parse(invalidSetting.content[0].text).error, /10000.*5000000/);
    assert.equal(readFileSync(store.path, 'utf8'), originalSettings);
  } finally { await client.close(); await server.close(); }
});

test('both captures once, registers separate usable references, and stores one original', async t => {
  const { captureScreenshot }=await import('../dist/operation/screenshot.js');
  const { mapScreenshotArguments }=await import('../dist/image/screenshot-coordinates.js');
  const { readdirSync }=await import('node:fs');
  const { historyDirectory }=await import('../dist/setting/screenshot-settings.js');
  const dir=fixture(t), path=join(dir,'source.png');
  await sharp({create:{width:1206,height:2622,channels:3,background:'white'}}).png().toFile(path);
  let captures=0;
  const fake={getConnectedDevice:()=> 'device',getScreenshotGeometry:()=>({udid:'device',scale:3}),screenshot:async output=>{captures++;copyFileSync(path,output);return output;}};
  const store=new ScreenshotSettingsStore(join(dir,'settings.json'));
  const response=await captureScreenshot(fake,store,undefined,{mode:'both'});
  assert.equal(captures,1);
  const [logical,pixel]=response.structuredContent.images;
  assert.notEqual(logical.screenshotId,pixel.screenshotId);
  assert.deepEqual(Object.keys(logical).sort(),['deviceInfo','imageSize','mode','screenshotId']);
  assert.ok(response.content.every(block=>block.type==='image'));
  assert.equal(readdirSync(historyDirectory(store)).length,1);
  assert.deepEqual(mapScreenshotArguments(fake,{screenshotId:logical.screenshotId,x:201,y:437}),{x:201,y:437});
  assert.deepEqual(mapScreenshotArguments(fake,{screenshotId:pixel.screenshotId,x:603,y:1311}),{x:201,y:437});
});

test('MCP chain preserves both image metadata in structuredContent without duplicating it as text', async t => {
  const dir=fixture(t),path=join(dir,'source.png');
  await sharp({create:{width:200,height:400,channels:3,background:'white'}}).png().toFile(path);
  const fake={getConnectedDevice:()=> 'device',getScreenshotGeometry:()=>({udid:'device',scale:2}),screenshot:async output=>{copyFileSync(path,output);return output;}};
  const server=createServer(fake,new ScreenshotSettingsStore(join(dir,'settings.json')));
  const client=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);await client.connect(b);
    const response=await client.callTool({name:'operation_chain',arguments:{steps:[{tool:'screenshot',arguments:{mode:'both'},delay:0}]}});
    assert.ok(!response.isError);
    const images=response.structuredContent.steps[0].result.images;
    assert.deepEqual(images.map(i=>i.mode),['logical','pixel']);
    assert.ok(images.every(i=>typeof i.screenshotId==='string'));
    assert.equal(response.content.filter(i=>i.type==='image').length,2);
    assert.ok(response.content.filter(i=>i.type==='text').every(i=>!i.text.includes('screenSize')));
  }finally{await client.close();await server.close();}
});
