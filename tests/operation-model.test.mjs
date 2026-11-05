import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRelativeTiming, prepareSteps, createParentId } from '../dist/common/operation.js';
import { operationChain } from '../dist/operation/observation-events.js';
import { gesturesTools } from '../dist/operation/gestures.js';

test('shared timeline follows 0/1/5/6 starts independently of 1/2/3/2 durations',()=>{
 const parentId='session_12345678';
 const entries=[ [0,1],[1,2],[5,3],[6,2] ].map(([time,duration])=>({tool:'tap',arguments:{x:1,y:2},startedAt:1000+time*1000,endedAt:1000+(time+duration)*1000}));
 const records=withRelativeTiming(entries,parentId,1000);
 assert.deepEqual(records.map(e=>[e.time,e.delay,e.duration]),[[0,0,1],[1,1,2],[5,4,3],[6,1,2]]);
 assert.ok(records.every(e=>e.parentId===parentId));
 const replay=operationChain(records);
 assert.equal(replay.replayable,true);
 assert.deepEqual(replay.steps.map(e=>e.delay),[0,1,4,1]);
 assert.match(replay.parentId,/^chain_[0-9a-f]{8}$/);
 assert.ok(replay.steps.every(e=>e.parentId===replay.parentId));
 assert.deepEqual(prepareSteps(replay.steps,gesturesTools,replay.parentId).map(e=>e.time),[0,1,5,6]);
});
test('observed replay candidates use executable argument and chain-limit validation',()=>{
 const record={parentId:'session_12345678',tool:'swipe',arguments:{x1:0,y1:0,x2:10,y2:10,duration:6},time:0,delay:0,duration:6};
 const candidate=operationChain([record]);
 assert.equal(candidate.replayable,false);
 assert.throws(()=>prepareSteps(candidate.steps,gesturesTools,candidate.parentId),/duration/);
 assert.equal(operationChain(Array.from({length:21},()=>({...record,tool:'tap',arguments:{x:0,y:0}}))).replayable,false);
});
test('different source parents and malformed timing are rejected before execution',()=>{
 const parentId=createParentId('chain');
 const tap={tool:'tap',arguments:{x:0,y:0},delay:0};
 assert.throws(()=>prepareSteps([{...tap,parentId:'session_12345678'},{...tap,delay:0.4,parentId:'session_87654321'}],gesturesTools,parentId),/same parentId/);
 for(const duration of [-1,Infinity,NaN])assert.throws(()=>prepareSteps([{...tap,duration}],gesturesTools,parentId),/duration/);
 assert.throws(()=>prepareSteps([{...tap,delay:null}],gesturesTools,parentId),/delay/);
 assert.throws(()=>prepareSteps([{...tap,arguments:null}],gesturesTools,parentId),/arguments/);
 assert.throws(()=>prepareSteps([{...tap,time:1}],gesturesTools,parentId),/time must equal/);
});
