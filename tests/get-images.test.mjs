import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/mcp/server.js';
import { createOperationChain } from '../dist/operation/operation-chain.js';
import { tools } from '../dist/mcp/registry.js';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';
import { ChainCaptureStore } from '../dist/storage/chain-captures.js';
import { ObservationStore } from '../dist/storage/observation-store.js';
import { saveTimelineCapture } from '../dist/storage/timeline-images.js';
import { cleanCache } from '../dist/storage/clean-cache.js';
const image=data=>({type:'image',mimeType:'image/png',data:Buffer.from(data).toString('base64')});
const raw=n=>({mode:'logical',imageSize:{width:100,height:200},elements:[{identifier:'button',type:'Button',label:`Button ${n}`,frame:{x:10,y:20,width:30,height:40}}]});
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'isimbot-get-images-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return {directory,settings:new ScreenshotSettingsStore(join(directory,'screenshot.json'))};}
function chainFixture(snapshots){let count=0;const capture={definition:{name:'capture',inputSchema:{type:'object',properties:{}}},responseType:'mcp',execute:async()=>{const n=count++;return {content:[image(`capture-${n}`)],structuredContent:snapshots[n]};}};return createOperationChain([capture,{definition:{name:'tap',inputSchema:{type:'object',properties:{}}},execute:async()=>({success:true})}]);}
async function offlineClient(settings){const device={getConnectedDevice:()=>null,listDevices:async()=>assert.fail('Image reads must not discover/connect to devices')};const server=createServer(device,settings,()=>device),client=new Client({name:'offline-image-retrieval',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);return{client,close:async()=>{await client.close();await server.close();}};}

test('chain captures return flat references, survive a new MCP server, and load in requested event order',async t=>{
 const {directory,settings}=fixture(t),chain=chainFixture([raw(0),raw(1)]);
 const result=await chain.execute({getConnectedDevice:()=> 'device'},{steps:['capture','tap','capture'].map(tool=>({tool,interval:0}))},settings);
 const summary=result.structuredContent;assert.equal(summary.success,true);assert.equal(summary.totalEvents,3);assert.ok(!Object.hasOwn(summary,'steps'));
 assert.equal(result.content.filter(c=>c.type==='image').length,0);
 assert.deepEqual(summary.events.map(e=>e.index),[0,1,2]);assert.ok(summary.events.every(e=>!Object.hasOwn(e,'timeline')));
 for(const event of summary.events.filter(e=>e.tool==='capture')){assert.ok(!Object.hasOwn(event,'result'));assert.ok(!Object.hasOwn(event.metadata,'elements'));assert.ok(!Object.hasOwn(event.metadata,'comparisonAvailable'));assert.ok(existsSync(event.images[0].path));}
 assert.deepEqual(summary.events[2].elements[0].changeTypes,['updated']);assert.equal(summary.events[2].comparedToIndex,0);
 const catalog=new ChainCaptureStore(join(directory,'chains')).find(summary.timeline);assert.deepEqual(catalog.captures.map(c=>c.index),[0,2]);assert.equal(catalog.captures[0].capture.metadata.elements[0].identifier,'button');
 const offline=await offlineClient(settings);try{
  const fetched=await offline.client.callTool({name:'get_images',arguments:{timeline:summary.timeline,indexes:[2,0]}});assert.ok(!fetched.isError);assert.deepEqual(fetched.content.filter(c=>c.type==='image').map(c=>Buffer.from(c.data,'base64').toString()),['capture-1','capture-0']);
  assert.deepEqual(fetched.structuredContent.events.map(e=>e.index),[2,0]);
  rmSync(summary.events[2].images[0].path);
  const partial=await offline.client.callTool({name:'get_images',arguments:{timeline:summary.timeline,indexes:[2,0,1]}});assert.ok(!partial.isError);assert.equal(partial.structuredContent.partial,true);assert.deepEqual(partial.structuredContent.events.map(e=>e.success),[false,true,false]);assert.equal(partial.content.filter(c=>c.type==='image').length,1);
 }finally{await offline.close();}
});

test('observations use the same image reader, general event indexes, and retain full raw data',async t=>{
 const {directory,settings}=fixture(t),timeline='session_1234abcd',store=new ObservationStore(join(directory,'observations'));
 const capture=saveTimelineCapture(store.directory,timeline,8,{content:[image('observed')],structuredContent:raw(0)});
 store.save({timeline,udid:'offline-device',bundleId:'test.app',startedAt:1,expireAt:2,captureInterval:0.5,events:[
  {timeline,index:0,tool:'tap',arguments:{x:1,y:1},timestamp:0,interval:0,duration:0.1,points:[{x:1,y:1,timestamp:0}]},
  {timeline,index:1,tool:'capture',arguments:{},timestamp:0.5,interval:0.5,duration:0.2,capture},
 ]},'archived');
 const before=readFileSync(store.observationsPath,'utf8'),offline=await offlineClient(settings);
 try{const result=await offline.client.callTool({name:'get_images',arguments:{timeline,indexes:[1]}});assert.ok(!result.isError);assert.equal(Buffer.from(result.content.find(c=>c.type==='image').data,'base64').toString(),'observed');assert.equal(readFileSync(store.observationsPath,'utf8'),before);}finally{await offline.close();}
});

test('get_images bounds batches, rejects arbitrary paths and does not disclose another timeline image',async t=>{
 const {directory,settings}=fixture(t),tool=tools.find(t=>t.definition.name==='get_images');
 for(const args of [{timeline:'../secret',indexes:[0]},{timeline:'chain_1234abcd',indexes:[]},{timeline:'chain_1234abcd',indexes:[0,0]},{timeline:'chain_1234abcd',indexes:[-1]},{timeline:'chain_1234abcd',indexes:[1.5]},{timeline:'chain_1234abcd',indexes:[0,1,2,3,4,5,6]},{timeline:'chain_1234abcd',indexes:[0],path:'/tmp/secret'}]) await assert.rejects(tool.execute({},args,settings));
 const chains=join(directory,'chains'),owner='chain_1234abcd',other='chain_87654321';
 const capture=saveTimelineCapture(chains,other,0,{content:[image('other timeline')],structuredContent:raw(0)});
 new ChainCaptureStore(chains).save({timeline:owner,udid:null,eventCount:1,captures:[{index:0,timestamp:0,capture}]});
 const result=await tool.execute({},{timeline:owner,indexes:[0]},settings);assert.equal(result.isError,true);assert.equal(result.content.filter(c=>c.type==='image').length,0);
});

test('both-mode image count limits report partial results instead of silently truncating a capture',async t=>{
 const {directory,settings}=fixture(t),timeline='chain_1234abcd',chains=join(directory,'chains');
 const captures=Array.from({length:4},(_,index)=>({index,timestamp:index,capture:saveTimelineCapture(chains,timeline,index,{content:[image(`${index}-logical`),image(`${index}-pixel`)],structuredContent:raw(index)})}));
 new ChainCaptureStore(chains).save({timeline,udid:null,eventCount:4,captures});
 const result=await tools.find(t=>t.definition.name==='get_images').execute({},{timeline,indexes:[0,1,2,3]},settings);
 assert.equal(result.structuredContent.partial,true);assert.deepEqual(result.structuredContent.events.map(e=>e.success),[true,true,true,false]);assert.equal(result.content.filter(c=>c.type==='image').length,6);
});

test('clean removes completed chain images but preserves catalog, pending media and user files',async t=>{
 const {directory,settings}=fixture(t),chains=join(directory,'chains'),timeline='chain_1234abcd';
 const capture=saveTimelineCapture(chains,timeline,0,{content:[image('completed')],structuredContent:raw(0)});
 new ChainCaptureStore(chains).save({timeline,udid:null,eventCount:1,captures:[{index:0,timestamp:0,capture}]});
 const pending=saveTimelineCapture(chains,'chain_87654321',0,{content:[image('pending')],structuredContent:raw(0)});
 const custom=join(chains,'images','custom.png');writeFileSync(custom,'keep');
 const catalog=readFileSync(join(chains,'captures.json'),'utf8');const result=cleanCache(settings);
 assert.equal(result.deletedFiles,1);assert.ok(!existsSync(capture.images[0].path));assert.ok(existsSync(pending.images[0].path));assert.ok(existsSync(custom));assert.equal(readFileSync(join(chains,'captures.json'),'utf8'),catalog);
});

test('image batches enforce encoded byte budget without corrupting saved media',async t=>{
 const {directory,settings}=fixture(t),timeline='chain_aabbccdd',chains=join(directory,'chains');
 const data=Buffer.alloc(4_100_000,1).toString('base64');
 const captures=Array.from({length:3},(_,index)=>({index,timestamp:index,capture:saveTimelineCapture(chains,timeline,index,{content:[{type:'image',mimeType:'image/png',data}],structuredContent:raw(index)})}));
 new ChainCaptureStore(chains).save({timeline,udid:null,eventCount:3,captures});
 const result=await tools.find(t=>t.definition.name==='get_images').execute({},{timeline,indexes:[0,1,2]},settings);
 assert.equal(result.structuredContent.partial,true);assert.equal(result.content.filter(c=>c.type==='image').length,2);
 assert.match(result.structuredContent.events[2].error,/limit/);assert.ok(captures.every(c=>existsSync(c.capture.images[0].path)));
});

test('concurrent processes retain separate chain catalogs and refuse to overwrite an existing timeline',async t=>{
 const {directory}=fixture(t),chains=join(directory,'chains');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const run=promisify(execFile);
 const module=new URL('../dist/storage/chain-captures.js',import.meta.url).href;
 await Promise.all(Array.from({length:4},(_,i)=>run(process.execPath,['--input-type=module','-e',`import {ChainCaptureStore} from ${JSON.stringify(module)};new ChainCaptureStore(${JSON.stringify(chains)}).save({timeline:'chain_0000000${i}',udid:null,eventCount:0,captures:[]});`])));
 const store=new ChainCaptureStore(chains);assert.equal(store.list().length,4);
 assert.throws(()=>store.save({timeline:'chain_00000000',udid:null,eventCount:0,captures:[]}),/already saved/);
 assert.equal(store.list().length,4);
});
