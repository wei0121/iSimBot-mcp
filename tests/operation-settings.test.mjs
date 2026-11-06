import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OperationSettingsStore } from '../dist/setting/operation-settings.js';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';
import { prepareSteps } from '../dist/common/operation.js';
import { tools } from '../dist/mcp/registry.js';
const parent='chain_aabbccdd';
const swipe={tool:'swipe',arguments:{x1:100,y1:600,x2:100,y2:300,duration:2},delay:0};
const tap=delay=>({tool:'tap',arguments:{x:100,y:200},...(delay===undefined?{}:{delay})});

test('minimum interval uses gesture duration and counts images without resetting previous command',()=>{
 const explicit=[swipe,{tool:'capture',delay:0.1},tap(0.3)];
 assert.throws(()=>prepareSteps(explicit,tools,parent),error=>error.details.code==='MIN_OPERATION_DELAY'&&Math.abs(error.details.minimumDelay-2.1)<1e-9);
 const steps=prepareSteps([swipe,{tool:'capture',delay:0.1},tap()],tools,parent,undefined,1000);
 assert.equal(steps[1].timestamp,1100);assert.equal(steps[2].timestamp,3200);assert.equal(steps[2].delay,2.1);
 assert.doesNotThrow(()=>prepareSteps([swipe,{tool:'capture',delay:0.1},{tool:'screenshot',delay:0.1}],tools,parent));
});
test('short explicit delays fail preflight before any side effects with actionable fields',async()=>{
 let called=0;
 const chain=tools.find(t=>t.definition.name==='operation_chain');
 await assert.rejects(chain.execute({swipe:async()=>called++,tap:async()=>called++},{steps:[swipe,tap(0.2)]},{}),e=>e.details.code==='MIN_OPERATION_DELAY'&&e.details.requiredInterval===2.2);
 assert.equal(called,0);
});
test('persistent partial per-tool updates preserve screenshot settings and reject invalid combined patches',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'isimbot-operation-settings-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const settings=new ScreenshotSettingsStore(join(dir,'screenshot.json'));
 const timing=new OperationSettingsStore(join(dir,'operations.json'));
 const setup=tools.find(t=>t.definition.name==='setup');
 assert.equal(timing.read().minDelay.tap,0.4);assert.equal(existsSync(timing.path),false);
 await setup.execute({}, {minDelay:{tap:0.6}},settings);
 assert.equal(timing.read().minDelay.tap,0.6);assert.equal(timing.read().minDelay.swipe,0.9);
 const saved=readFileSync(timing.path,'utf8');
 await assert.rejects(setup.execute({}, {mode:'pixel',minDelay:{tap:-1}},settings));
 assert.equal(readFileSync(timing.path,'utf8'),saved);assert.equal(settings.read().mode,'logical');
 await assert.rejects(setup.execute({}, {mode:'bad',minDelay:{tap:1}},settings));
 assert.equal(readFileSync(timing.path,'utf8'),saved);
 const restarted=await setup.execute({}, {},new ScreenshotSettingsStore(settings.path));
 assert.equal(restarted.configuration.minDelay.tap,0.6);
 const request=[{...tap(0),delay:0},tap(0.4)];
 assert.throws(()=>prepareSteps(request,tools,parent,timing.read()),/minimum is 0.600/);
 for(const patch of [{capture:1},{tap:11},{tap:null},{unknown:1}])assert.throws(()=>timing.update(patch));
});
