import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentElements as present } from '../dist/mcp/element-presentation.js';
import { ObservationStore } from '../dist/storage/observation-store.js';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';
import { tools } from '../dist/mcp/registry.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/mcp/server.js';

const node=(identifier,label='Search',x=10,extra={})=>({identifier,label,title:null,value:null,role:'AXButton',type:'Button',enabled:true,frame:{x,y:20,width:100,height:40},center:{x:x+50,y:40},...extra});
const metadata=elements=>({screenshotId:'stored-id',mode:'logical',imageSize:{width:402,height:874},deviceInfo:{screenSize:{width:402,height:874},scale:3},elements});

test('presentation selects counts/compact lists/initial changes without modifying raw snapshots',()=>{
 const input=metadata([node('search'),node(null,'Maximum price',10,{value:'2000',type:'TextField'})]);
 const original=JSON.stringify(input);
 const number=present(input,undefined,'number',false);
 assert.equal(number.elementCount,2);assert.ok(!Object.hasOwn(number,'elements'));
 const list=present(input,undefined,'list',false);
 assert.deepEqual(list.elements[0],{elementId:'search',type:'Button',text:'Search',frame:{x:10,y:20,width:100,height:40}});
 assert.equal(list.elements[1].text,'Maximum price · 2000');
 const changes=present(input,undefined,'changes',false);
 assert.ok(changes.elements.every(e=>e.changeTypes.join()==='appeared'));
 assert.deepEqual(changes.metadata.imageSize,input.imageSize);
 assert.equal(JSON.stringify(input),original);
});

test('changes distinguish simultaneous movement/content updates, appearance, disappearance and unchanged reordering',()=>{
 const previous=metadata([node('unchanged'),node('move'),node('update'),node('both'),node('gone')]);
 const current=metadata([node('both','New text',40),node('move','Search',30),node('unchanged'),node('update','Updated'),node('new')]);
 const raw=JSON.stringify([previous,current]);
 const changes=present(current,previous,'changes',true).elements;
 assert.deepEqual(changes.map(e=>[e.elementId,e.changeTypes]),[
  ['both',['moved','updated']],['move',['moved']],['update',['updated']],['new',['appeared']],['gone',['disappeared']],
 ]);
 assert.deepEqual(changes.at(-1).frame,previous.elements.at(-1).frame);
 assert.equal(changes.at(-1).text,'Search');
 assert.deepEqual(present(metadata([...previous.elements].reverse()),previous,'changes',true).elements,[]);
 assert.equal(JSON.stringify([previous,current]),raw);
 const disabled=present(metadata([node('a','Search',10,{enabled:false})]),metadata([node('a')]),'changes',true);
 assert.deepEqual(disabled.elements[0].changeTypes,['updated']);
});

test('anonymous and duplicate IDs never cause fabricated moves or identity merges',()=>{
 const previous=metadata([node(null),node(null),node('duplicate','First'),node('duplicate','Second',150)]);
 const same=metadata([previous.elements[3],previous.elements[0],previous.elements[2],previous.elements[1]]);
 assert.deepEqual(present(same,previous,'changes',true).elements,[]);
 const changed=metadata([node(null),node(null,'Search',50),node('duplicate','First'),node('duplicate','Second',180)]);
 const result=present(changed,previous,'changes',true).elements;
 assert.equal(result.length,3);
 assert.deepEqual(result.map(e=>e.changeTypes),[['appeared'],['moved'],['disappeared']]);
 assert.equal(result[0].elementId,null);
 // A new identifier is a different element, even with the same text/geometry.
 assert.deepEqual(present(metadata([node('b')]),metadata([node('a')]),'changes',true).elements.map(e=>e.changeTypes),[['appeared'],['disappeared']]);
});

test('unavailable snapshots are distinguished from empty element lists',()=>{
 const missing={elements:null,elementsError:'AX read failed'},valid=metadata([node('a')]);
 assert.equal(present(missing,valid,'number',true).elementCount,null);
 assert.equal(present(missing,valid,'list',true).elements,null);
 const noBaseline=present(valid,missing,'changes',true);
 assert.equal(noBaseline.elements,null);assert.equal(noBaseline.elements,null);
 assert.match(noBaseline.error,/Previous/);
 const noCurrent=present(missing,valid,'changes',true);
 assert.equal(noCurrent.elements,null);assert.equal(noCurrent.error,'AX read failed');
 assert.deepEqual(present(metadata([]),valid,'changes',true).elements[0].changeTypes,['disappeared']);
 assert.deepEqual(present(metadata([]),undefined,'changes',false).elements,[]);
});

function fixture(t, snapshots) {
 const directory=mkdtempSync(join(tmpdir(),'isimbot-observation-presentation-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const settings=new ScreenshotSettingsStore(join(directory,'screenshot.json'));
 const store=new ObservationStore(join(directory,'observations')),timeline='session_1234abcd';
 const events=snapshots.map((snapshot,index)=>({timeline,tool:'capture',arguments:{},index,time:index*0.5,delay:index?0.5:0,duration:0.2,
  ...(snapshot===undefined?{error:'Capture failed'}:{capture:{images:[{path:join(directory,'missing.png'),mimeType:'image/png',sizeBytes:1}],metadata:snapshot}})}));
 store.save({timeline,udid:'device',bundleId:'test.app',startedAt:1,expireAt:1001,captureInterval:0.5,events},'archived');
 const client={getConnectedDevice:()=> 'device'};
 const call=args=>tools.find(t=>t.definition.name==='get_observation').execute(client,{timeline,...args},settings);
 return {store,settings,timeline,client,call};
}

test('pagination compares to the previous capture outside the page, not the previous get request; stored JSON stays full',async t=>{
 const f=fixture(t,[metadata([node('a')]),metadata([node('a','Changed',50)]),metadata([node('b')])]);
 const before=readFileSync(f.store.observationsPath,'utf8');
 await f.call({offset:2,limit:1,elementDetail:'list'});
 const result=await f.call({offset:1,limit:1});
 assert.equal(result.structuredContent.elementDetail,'changes');
 const event=result.structuredContent.events[0];assert.equal(event.comparedToIndex,0);
 assert.deepEqual(event.elements[0].changeTypes,['moved','updated']);
 assert.equal(event.elements[0].elementId,'a');
 const numbered=await f.call({offset:1,limit:1,elementDetail:'number'});
 assert.equal(numbered.structuredContent.events[0].elementCount,1);
 assert.ok(!Object.hasOwn(numbered.structuredContent.events[0],'elements'));
 const missingImage=await f.call({offset:1,limit:1,includeImages:true});
 assert.match(missingImage.structuredContent.events[0].error,/Capture image unavailable/);
 assert.ok(!Object.hasOwn(missingImage.structuredContent.events[0].elements[0],'identifier'));
 assert.equal(readFileSync(f.store.observationsPath,'utf8'),before);
 assert.equal(JSON.parse(before)[0].events[0].capture.metadata.elements[0].identifier,'a');
});

test('a failed capture breaks the comparison baseline instead of fabricating disappearance/appearance',async t=>{
 const f=fixture(t,[metadata([node('a')]),undefined,metadata([node('a')])]);
 const result=await f.call({offset:2,limit:1});const event=result.structuredContent.events[0];
 assert.equal(event.comparedToIndex,1);assert.equal(event.elements,null);assert.equal(event.elements,null);
 const list=await f.call({offset:2,limit:1,elementDetail:'list'});
 assert.equal(list.structuredContent.events[0].elements[0].elementId,'a');
});

test('MCP exposes all modes, returns 100 capture events by default, and preserves 0.5-second raw timing',async t=>{
 const f=fixture(t,Array.from({length:100},()=>metadata([node('a')])));
 const server=createServer(f.client,f.settings,()=>f.client),client=new Client({name:'presentation-test',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);
  const definition=(await client.listTools()).tools.find(t=>t.name==='get_observation');
  assert.equal(definition.inputSchema.properties.elementDetail.default,'changes');
  const result=await client.callTool({name:'get_observation',arguments:{timeline:f.timeline}});
  assert.ok(!result.isError);assert.equal(result.structuredContent.events.length,100);assert.equal(result.structuredContent.nextOffset,null);
  assert.equal(result.structuredContent.captureInterval,0.5);
  assert.equal(result.structuredContent.events[0].elements.length,1);
  assert.ok(result.structuredContent.events.slice(1).every(e=>e.elements.length===0));
  const number=await client.callTool({name:'get_observation',arguments:{timeline:f.timeline,elementDetail:'number',limit:1}});
  assert.equal(number.structuredContent.events[0].elementCount,1);
  const invalid=await client.callTool({name:'get_observation',arguments:{timeline:f.timeline,elementDetail:'full'}});assert.equal(invalid.isError,true);
 }finally{await client.close();await server.close();}
});

test('mixed timeline pagination and element comparison use general event indexes, including old archives',async t=>{
 const f=fixture(t,[metadata([node('a')]),metadata([node('a','New',50)])]);
 // Simulate an archive from the old capture-only counter format without migrating it on disk.
 const sessions=JSON.parse(readFileSync(f.store.observationsPath,'utf8'));
 sessions[0].events[0].index=8;sessions[0].events[1].index=9;
 sessions[0].events.splice(1,0,{timeline:f.timeline,tool:'tap',arguments:{x:20,y:20},time:0.25,delay:0.25,duration:0.1,points:[{x:20,y:20,time:250}]});
 const {writeFileSync}=await import('node:fs');writeFileSync(f.store.observationsPath,JSON.stringify(sessions));
 const before=readFileSync(f.store.observationsPath,'utf8');
 const all=await f.call({});assert.deepEqual(all.structuredContent.events.map(e=>e.index),[0,1,2]);
 const paged=await f.call({offset:2,limit:1});const event=paged.structuredContent.events[0];
 assert.equal(event.index,2);assert.equal(event.comparedToIndex,0);assert.deepEqual(event.elements[0].changeTypes,['moved','updated']);
 assert.ok(!Object.hasOwn(paged.structuredContent,'operationChain'));
 assert.equal(readFileSync(f.store.observationsPath,'utf8'),before);
});
