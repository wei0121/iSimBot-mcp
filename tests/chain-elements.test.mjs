import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOperationChain } from '../dist/operation/operation-chain.js';
import { presentElements } from '../dist/mcp/element-presentation.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/mcp/server.js';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const element=(id,label,x=10)=>({identifier:id,type:'Button',role:'AXButton',label,title:null,value:null,enabled:true,frame:{x,y:20,width:30,height:20},center:{x:x+15,y:30}});
const metadata=elements=>({screenshotId:'raw-reference',mode:'logical',imageSize:{width:100,height:200},deviceInfo:{deviceId:'device',screenSize:{width:100,height:200},scale:1},elements});
const before=metadata([element('a','Alpha'),element('b','Beta')]);
const after=metadata([element('a','Alpha updated',40),element('b','Beta'),element('c','New')]);
function fixture(snapshots) {
 let count=0,clock=0;
 const screenshotMetadata={screenshotId:'screenshot-reference',mode:'pixel',imageSize:{width:300,height:600},deviceInfo:{deviceId:'device',scale:3}};
 const capture={definition:{name:'capture',inputSchema:{type:'object',properties:{}}},responseType:'mcp',execute:async()=>({structuredContent:snapshots[count++],content:[{type:'image',mimeType:'image/png',data:'capture-image'}]})};
 const screenshot={definition:{name:'screenshot',inputSchema:{type:'object',properties:{}}},responseType:'mcp',execute:async()=>({structuredContent:screenshotMetadata,content:[{type:'image',mimeType:'image/png',data:'screenshot-image'}]})};
 const tap={definition:{name:'tap',inputSchema:{type:'object',properties:{}}},execute:async()=>({success:true})};
 const chain=createOperationChain([capture,tap,screenshot],async ms=>{clock+=ms;},()=>clock);
 return {chain,screenshotMetadata,calls:()=>count};
}
const steps=['capture','tap','screenshot','capture','capture'].map(tool=>({tool,delay:0}));

test('chain defaults to shared changes against raw capture snapshots, ignoring intervening tools',async()=>{
 const raw=JSON.stringify([before,after]);const f=fixture([before,after,after]);
 const result=await f.chain.execute({}, {steps}, {}),summary=result.structuredContent;
 assert.equal(summary.success,true);assert.equal(summary.elementDetail,'changes');
 assert.equal(summary.events[0].comparedToIndex,null);
 assert.deepEqual((({metadata,elements})=>({metadata,elements}))(summary.events[0]),presentElements(before,undefined,'changes',false));
 assert.equal(summary.events[3].comparedToIndex,0);
 assert.deepEqual((({metadata,elements})=>({metadata,elements}))(summary.events[3]),presentElements(after,before,'changes',true));
 assert.deepEqual(summary.events[3].elements.map(e=>[e.elementId,e.changeTypes]),[['a',['moved','updated']],['c',['appeared']]]);
 assert.equal(summary.events[4].comparedToIndex,3);assert.deepEqual(summary.events[4].elements,[]);
 assert.deepEqual(summary.events[2].result,f.screenshotMetadata);
 assert.deepEqual(summary.events.map(s=>s.index),[0,1,2,3,4]);
 assert.deepEqual(result.content.filter(c=>c.type==='image').map(c=>c.data),['screenshot-image']);
 assert.equal(JSON.stringify([before,after]),raw);
});

test('chain supports number/list and rejects invalid presentation options before actions',async()=>{
 for(const detail of ['number','list']) {
  const f=fixture([before,after]);const result=await f.chain.execute({}, {elementDetail:detail,steps:[{tool:'capture',delay:0},{tool:'capture',delay:0}]},{});
  assert.equal(result.structuredContent.elementDetail,detail);
  for(const [i,snapshot] of [before,after].entries()) assert.deepEqual((({metadata,elements,elementCount})=>Object.fromEntries(Object.entries({metadata,elements,elementCount}).filter(([,v])=>v!==undefined)))(result.structuredContent.events[i]),presentElements(snapshot,undefined,detail,false));
  assert.equal(result.content.filter(c=>c.type==='image').length,0);
  if(detail==='number') assert.ok(!Object.hasOwn(result.structuredContent.events[0],'elements'));
  else assert.deepEqual(Object.keys(result.structuredContent.events[0].elements[0]).sort(),['elementId','frame','text','type']);
 }
 for(const value of ['full',null,1,{},['changes']]){
  const f=fixture([before]);await assert.rejects(f.chain.execute({}, {steps:[{tool:'capture',delay:0}],elementDetail:value},{}),/elementDetail/);assert.equal(f.calls(),0);
 }
});

test('concurrent capture completion order cannot change element baselines',async()=>{
 let release,count=0;const held=new Promise(r=>{release=r;});
 const capture={definition:{name:'capture',inputSchema:{type:'object',properties:{}}},responseType:'mcp',execute:async()=>{
  const index=count++;if(index===0)await held;else release();return {structuredContent:index?after:before,content:[{type:'image',mimeType:'image/png',data:'aGk='}]};
 }};
 const chain=createOperationChain([capture],async()=>{});
 const result=await chain.execute({}, {steps:[{tool:'capture',delay:0},{tool:'capture',delay:0}]},{});
 assert.equal(result.structuredContent.success,true);
 assert.deepEqual((({metadata,elements})=>({metadata,elements}))(result.structuredContent.events[0]),presentElements(before,undefined,'changes',false));
 assert.deepEqual((({metadata,elements})=>({metadata,elements}))(result.structuredContent.events[1]),presentElements(after,before,'changes',true));
 assert.equal(result.structuredContent.events[1].comparedToIndex,0);
});

test('missing accessibility snapshots break the baseline and each new chain starts independently',async()=>{
 const missing={...metadata(null),elementsError:'AX unavailable'},f=fixture([before,missing,after]);
 const result=await f.chain.execute({}, {steps:Array.from({length:3},()=>({tool:'capture',delay:0}))},{});
 assert.equal(result.structuredContent.success,true);
 assert.equal(result.structuredContent.events[1].elements,null);
 assert.equal(result.structuredContent.events[1].elements,null);
 assert.equal(result.structuredContent.events[2].comparedToIndex,1);
 assert.equal(result.structuredContent.events[2].elements,null);
 const fresh=await fixture([after]).chain.execute({}, {steps:[{tool:'capture',delay:0}]},{});
 assert.equal(fresh.structuredContent.events[0].comparedToIndex,null);
 assert.ok(fresh.structuredContent.events[0].elements.every(e=>e.changeTypes.join()==='appeared'));
});

test('actual MCP capture handlers expose chain elementDetail while standalone capture remains complete',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'isimbot-chain-elements-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 let reads=0;
 const fake={getConnectedDevice:()=> 'device',getScreenshotGeometry:()=>({udid:'device',scale:1}),
 screenshot:async path=>{await sharp({create:{width:100,height:200,channels:3,background:'white'}}).png().toFile(path);return path;},
 describeUI:async()=>JSON.stringify([{AXUniqueId:'button',AXLabel:'Search',type:'Button',role:'AXButton',frame:{x:10+(reads++)*5,y:20,width:30,height:20}}])};
 fake.captureScreen=async path=>{
  const startedAt=Date.now();const reads=await Promise.allSettled([fake.screenshot(path),fake.describeUI()]);
  if(reads[0].status==='rejected')throw reads[0].reason;
  return {path,timestamp:startedAt,captureTiming:{image:{startedAt,finishedAt:Date.now()},elements:{startedAt,finishedAt:Date.now()}},
   ...(reads[1].status==='fulfilled'?{elements:reads[1].value}:{elementsError:reads[1].reason.message})};
 };
 const server=createServer(fake,new ScreenshotSettingsStore(join(directory,'screenshot.json')),()=>fake),client=new Client({name:'chain-element-detail',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try {
  await server.connect(a);await client.connect(b);
  const definition=(await client.listTools()).tools.find(t=>t.name==='operation_chain');assert.equal(definition.inputSchema.properties.elementDetail.default,'changes');
  const changed=await client.callTool({name:'operation_chain',arguments:{steps:[{tool:'capture',delay:0},{tool:'capture',delay:0.01}]}});
  assert.ok(!changed.isError);assert.equal(changed.structuredContent.events[1].comparedToIndex,0);
  assert.deepEqual(changed.structuredContent.events[1].elements[0].changeTypes,['moved']);assert.equal(changed.content.filter(c=>c.type==='image').length,0);
  for(const detail of ['number','list']) {
   const result=await client.callTool({name:'operation_chain',arguments:{elementDetail:detail,steps:[{tool:'capture',delay:0}]}});
   assert.ok(!result.isError);const metadata=result.structuredContent.events[0];
   if(detail==='number')assert.equal(metadata.elementCount,1);else assert.equal(metadata.elements[0].elementId,'button');
  }
  const direct=await client.callTool({name:'capture',arguments:{}});assert.equal(direct.structuredContent.elements[0].identifier,'button');assert.ok(Object.hasOwn(direct.structuredContent.elements[0],'center'));
  const invalid=await client.callTool({name:'operation_chain',arguments:{elementDetail:'invalid',steps:[{tool:'capture',delay:0}]}});assert.equal(invalid.isError,true);
 }finally{await client.close();await server.close();}
});
