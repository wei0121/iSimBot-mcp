import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typeIntoFocusedField } from '../dist/operation/text-input.js';
import { parseObservationSnapshot, translateEditing, translateTouches, observationEvents, operationChain } from '../dist/operation/observation-events.js';
import { tools } from '../dist/mcp/registry.js';

test('plain apps retain literal ASCII insert; Unicode, replace and clear require explicit enhanced launch', async()=>{
 const sent=[]; const client={typeText:async text=>sent.push(text)};
 const text='\\$(echo hacked); "literal"';
 const result=await typeIntoFocusedField(client,text);
 assert.equal(result.transport,'idb');assert.deepEqual(sent,[text]);
 for(const [text,mode]of[['中文🙂','insert'],['abc','replace'],['','replace']]){
  await assert.rejects(typeIntoFocusedField(client,text,mode),e=>e.details.code==='ENHANCED_INPUT_REQUIRED');
 }
 assert.equal(sent.length,1);
 await assert.rejects(typeIntoFocusedField(client,'a'.repeat(131073)),e=>e.details.code==='TEXT_TOO_LARGE');
});
test('type_text rejects invalid modes before executing, including operation chains',async()=>{
 const tool=tools.find(t=>t.definition.name==='type_text');
 await assert.rejects(tool.execute({}, {text:'x',mode:'paste'}, {}),/mode/);
 const chain=tools.find(t=>t.definition.name==='operation_chain');
 await assert.rejects(chain.execute({}, {steps:[{tool:'type_text',arguments:{text:'x',mode:'paste'}}]},{}),/mode/);
});
test('Observe editing events validate, preserve target/request/composition, share timeline and cannot claim replayability',()=>{
 const timeline='session_aabbccdd';
 const details={target:{elementId:'title',type:'UITextField',frame:{x:10,y:20,width:300,height:40}},text:'中文🙂',textLength:4,redacted:false,composing:false,source:'agent',requestId:'req'};
 const samples=['editing_begin','text_change','editing_end'].map((type,i)=>({type,time:1000+i*100,timeline,details}));
 const value={timeline,handshake:{type:'ready',timeline,protocol:5,bundleId:'app.test'},samples};
 const parsed=parseObservationSnapshot(JSON.stringify(value),timeline);
 assert.deepEqual(translateTouches(parsed.samples),[]);
 const events=observationEvents(translateEditing(parsed.samples),[],timeline,900);
 assert.deepEqual(events.map(e=>e.tool),['editing_begin','text_change','editing_end']);
 assert.deepEqual(events.map(e=>e.delay),[0.1,0.1,0.1]);
 assert.ok(events.every(e=>e.duration===0));assert.equal(events[1].arguments.requestId,'req');
 assert.equal(events[1].arguments.target.elementId,'title');
 assert.equal(operationChain(events).replayable,false);
 for(const broken of [{...details,redacted:true},{...details,textLength:1},{...details,target:{...details.target,frame:{}}},{...details,source:'human'}]){
  assert.throws(()=>parseObservationSnapshot(JSON.stringify({...value,samples:[{...samples[0],details:broken}]}),timeline),/editing event/);
 }
 const secure={...details,text:null,redacted:true};
 assert.equal(parseObservationSnapshot(JSON.stringify({...value,samples:[{...samples[0],details:secure}]}),timeline).samples[0].details.text,null);
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTextInput, awaitTextInput, releaseTextInput, nativeLibrary } from '../dist/operation/text-input.js';

test('text IPC isolates clients and sessions, matches request IDs, propagates rejection, rejects duplicate in-flight input and cleans leases', {skip:!existsSync(nativeLibrary())},async t=>{
 const root=mkdtempSync(join(tmpdir(),'isimbot-text-ipc-')),path=process.env.PATH;
 const a={getConnectedDevice:()=> 'device-a'},b={getConnectedDevice:()=> 'device-b'};
 writeFileSync(join(root,'xcrun'),`#!${process.execPath}\nconsole.log(${JSON.stringify(root)}+'/'+process.argv[4]);\n`,{mode:0o755});
 process.env.PATH=`${root}:${path}`;
 t.after(()=>{releaseTextInput(a);releaseTextInput(b);process.env.PATH=path;rmSync(root,{recursive:true,force:true});});
 const envA=await prepareTextInput(a,'app.test'),envB=await prepareTextInput(b,'app.test');
 assert.notEqual(envA.SIMCTL_CHILD_ISIMBOT_TEXT_INPUT_SESSION,envB.SIMCTL_CHILD_ISIMBOT_TEXT_INPUT_SESSION);
 function ready(device,env){const dir=join(root,device,'tmp','isimbot-input-'+env.SIMCTL_CHILD_ISIMBOT_TEXT_INPUT_SESSION);writeFileSync(join(dir,'ready.json'),JSON.stringify({sessionId:env.SIMCTL_CHILD_ISIMBOT_TEXT_INPUT_SESSION,bundleId:'app.test',protocol:1,pid:process.pid}));return dir;}
 const dirA=ready('device-a',envA),dirB=ready('device-b',envB);
 await awaitTextInput(a);await awaitTextInput(b);
 const pending=typeIntoFocusedField(a,'中文','replace');
 await assert.rejects(typeIntoFocusedField(a,'duplicate'),e=>e.details.code==='TEXT_INPUT_BUSY');
 const command=JSON.parse(readFileSync(join(dirA,'command.json'),'utf8'));
 assert.equal(command.text,'中文');assert.equal(command.mode,'replace');
 assert.equal(existsSync(join(dirB,'command.json')),false);
 const reply=(extra={})=>writeFileSync(join(dirA,'response.json'),JSON.stringify({...command,text:undefined,expiresAt:undefined,success:true,...extra}));
 reply({requestId:'old-request',success:false});
 let settled=false;void pending.then(()=>settled=true,()=>settled=true);
 await new Promise(r=>setTimeout(r,60));assert.equal(settled,false);
 reply({sessionId:'wrong-session'});await new Promise(r=>setTimeout(r,60));assert.equal(settled,false);
 reply({details:{text:'中文'}});
 const result=await pending;assert.equal(result.details.text,'中文');assert.equal(result.requestId,command.requestId);assert.equal(result.transport,'native');
 assert.equal(existsSync(join(dirA,'command.json')),false);
 const rejected=typeIntoFocusedField(a,'拒绝','replace');
 const next=JSON.parse(readFileSync(join(dirA,'command.json'),'utf8'));
 writeFileSync(join(dirA,'response.json'),JSON.stringify({sessionId:next.sessionId,requestId:next.requestId,success:false,code:'TEXT_INPUT_REJECTED_OR_TRANSFORMED',error:'Validation rejected',details:{text:'中文'}}));
 await assert.rejects(rejected,e=>e.details.code==='TEXT_INPUT_REJECTED_OR_TRANSFORMED'&&e.details.details.text==='中文');
 const timeout=typeIntoFocusedField(b,'超时','replace');
 const timed=JSON.parse(readFileSync(join(dirB,'command.json'),'utf8'));
 await assert.rejects(timeout,e=>e.details.code==='TEXT_INPUT_TIMEOUT'&&e.details.requestId===timed.requestId);
 assert.equal(existsSync(join(dirB,'command.json')),false);
 assert.deepEqual(JSON.parse(readFileSync(join(dirB,'cancel.json'),'utf8')),{sessionId:timed.sessionId,requestId:timed.requestId});
 releaseTextInput(a);assert.equal(existsSync(dirA),false);assert.equal(existsSync(dirB),true);
 await assert.rejects(typeIntoFocusedField(a,'中文'),e=>e.details.code==='ENHANCED_INPUT_REQUIRED');
});
