import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/mcp/server.js';
import {tools} from '../dist/mcp/registry.js';
import {ScreenshotSettingsStore} from '../dist/setting/screenshot-settings.js';
import {OperationSettingsStore} from '../dist/setting/operation-settings.js';
import {ObservationStore} from '../dist/storage/observation-store.js';
function fixture(t){const root=mkdtempSync(join(tmpdir(),'isimbot-interval-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}

test('MCP advertises interval/minInterval and returns interval events before any client migration ambiguity',async t=>{
 const root=fixture(t),fake={getConnectedDevice:()=> 'device',tap:async()=>{}};
 const server=createServer(fake,new ScreenshotSettingsStore(join(root,'settings.json')),()=>fake),client=new Client({name:'interval-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);assert.match(client.getInstructions(),/interval is seconds from the previous step START/);assert.ok(!client.getInstructions().includes('delay'));
  const list=(await client.listTools()).tools,chain=list.find(t=>t.name==='operation_chain'),setup=list.find(t=>t.name==='setup');
  assert.equal(chain.inputSchema.properties.steps.items.properties.interval.default,0.3);assert.ok(!Object.hasOwn(chain.inputSchema.properties.steps.items.properties,'delay'));
  assert.ok(setup.inputSchema.properties.minInterval);assert.ok(!Object.hasOwn(setup.inputSchema.properties,'minDelay'));
  const response=await client.callTool({name:'operation_chain',arguments:{steps:[{tool:'tap',arguments:{x:1,y:2},interval:0}]}});assert.ok(!response.isError);
  const event=response.structuredContent.events[0];assert.ok(Number.isFinite(event.interval));assert.ok(!Object.hasOwn(event,'delay'));assert.ok(Number.isFinite(event.duration));
 }finally{await client.close();await server.close();}
});

test('old request fields fail preflight with rename guidance before earlier actions execute',async()=>{
 let taps=0;const chain=tools.find(t=>t.definition.name==='operation_chain');
 await assert.rejects(chain.execute({tap:async()=>taps++},{steps:[{tool:'tap',arguments:{x:1,y:2},interval:0},{tool:'tap',arguments:{x:2,y:3},delay:0.5}]},{}),e=>e.details.code==='RENAMED_ARGUMENT'&&e.details.replacement==='interval');assert.equal(taps,0);
 await assert.rejects(tools.find(t=>t.definition.name==='setup').execute({}, {minDelay:{tap:0.8}},{}),/renamed to minInterval/);
});

test('legacy operation settings read as minInterval without rewriting, then save only the new name',t=>{
 const root=fixture(t),path=join(root,'operations.json'),store=new OperationSettingsStore(path);
 const raw=JSON.stringify({minDelay:{tap:0.8}});writeFileSync(path,raw);
 assert.equal(store.read().minInterval.tap,0.8);assert.ok(!Object.hasOwn(store.read(),'minDelay'));assert.equal(readFileSync(path,'utf8'),raw);
 store.update({swipe:1.2});const saved=JSON.parse(readFileSync(path));assert.equal(saved.minInterval.tap,0.8);assert.equal(saved.minInterval.swipe,1.2);assert.ok(!Object.hasOwn(saved,'minDelay'));
});

test('old observation delay reads as interval while duration and raw archive remain unchanged',t=>{
 const root=fixture(t),store=new ObservationStore(root),timeline='session_12345678',timestamp=1794000000000;
 const session={timeline,udid:'device',bundleId:'app.test',startedAt:timestamp,expireAt:timestamp+1000,captureInterval:0.5,events:[{timeline,tool:'tap',arguments:{x:1,y:2},timestamp:timestamp+500,delay:0.5,duration:0.1}]};
 const raw=JSON.stringify([session]);writeFileSync(store.observationsPath,raw);
 const event=store.find(timeline).events[0];assert.equal(event.interval,0.5);assert.equal(event.duration,0.1);assert.equal(event.timestamp,timestamp+500);assert.ok(!Object.hasOwn(event,'delay'));assert.equal(readFileSync(store.observationsPath,'utf8'),raw);
});
