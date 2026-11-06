import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimestampTiming, prepareSteps, createTimeline } from '../dist/common/operation.js';
import { operationChain } from '../dist/operation/observation-events.js';
import { gesturesTools } from '../dist/operation/gestures.js';

test('shared timeline follows 0/1/5/6 starts independently of 1/2/3/2 durations',()=>{
 const timeline='session_12345678';
 const entries=[ [0,1],[1,2],[5,3],[6,2] ].map(([timestamp,duration])=>({tool:'tap',arguments:{x:1,y:2},startedAt:1000+timestamp*1000,endedAt:1000+(timestamp+duration)*1000}));
 const records=withTimestampTiming(entries,timeline,1000);
 assert.deepEqual(records.map(e=>e.index),[0,1,2,3]);
 assert.deepEqual(records.map(e=>[e.timestamp,e.delay,e.duration]),[[1000,0,1],[2000,1,2],[6000,4,3],[7000,1,2]]);
 assert.ok(records.every(e=>e.timeline===timeline));
 const replay=operationChain(records);
 assert.equal(replay.replayable,true);
 assert.deepEqual(replay.steps.map(e=>e.index),[0,1,2,3]);
 assert.deepEqual(replay.steps.map(e=>e.delay),[0,1,4,1]);
 assert.match(replay.timeline,/^chain_[0-9a-f]{8}$/);
 assert.ok(replay.steps.every(e=>!Object.hasOwn(e,'timeline')));
 assert.deepEqual(prepareSteps(replay.steps,gesturesTools,replay.timeline,undefined,1000).map(e=>e.timestamp),[1000,2000,6000,7000]);
});
test('observed replay candidates use executable argument and chain-limit validation',()=>{
 const record={timeline:'session_12345678',tool:'swipe',arguments:{x1:0,y1:0,x2:10,y2:10,duration:6},timestamp:0,delay:0,duration:6};
 const candidate=operationChain([record]);
 assert.equal(candidate.replayable,false);
 assert.throws(()=>prepareSteps(candidate.steps,gesturesTools,candidate.timeline),/duration/);
 assert.equal(operationChain(Array.from({length:101},()=>({...record,tool:'tap',arguments:{x:0,y:0}}))).replayable,false);
});
test('different source parents and malformed timing are rejected before execution',()=>{
 const timeline=createTimeline('chain');
 const tap={tool:'tap',arguments:{x:0,y:0},delay:0};
 assert.throws(()=>prepareSteps([{...tap,timeline:'session_12345678'},{...tap,delay:0.4,timeline:'session_87654321'}],gesturesTools,timeline),/same timeline/);
 for(const duration of [-1,Infinity,NaN])assert.throws(()=>prepareSteps([{...tap,duration}],gesturesTools,timeline),/duration/);
 assert.throws(()=>prepareSteps([{...tap,delay:null}],gesturesTools,timeline),/delay/);
 assert.throws(()=>prepareSteps([{...tap,arguments:null}],gesturesTools,timeline),/arguments/);
 assert.throws(()=>prepareSteps([{...tap,timestamp:1.5}],gesturesTools,timeline),/timestamp/);
});

test('common event indexes include all tools, preserve ties, and ignore source numbering when replayed',()=>{
 const timeline='session_12345678';
 const source=[{tool:'tap',arguments:{x:1,y:2},startedAt:1000,endedAt:1500,index:99},
  {tool:'capture',arguments:{},startedAt:1200,endedAt:1300,index:44},
  {tool:'swipe',arguments:{x1:0,y1:0,x2:20,y2:20},startedAt:1000,endedAt:1400,index:11}];
 const result=withTimestampTiming(source,timeline,1000);
 assert.deepEqual(result.map(e=>[e.index,e.tool,e.timestamp]),[[0,'tap',1000],[1,'swipe',1000],[2,'capture',1200]]);
 assert.deepEqual(source.map(e=>e.index),[99,44,11]);
 const chain=createTimeline('chain');
 const steps=prepareSteps([{tool:'tap',index:5,arguments:{x:1,y:2},delay:0},{tool:'tap',index:9,arguments:{x:1,y:2},delay:0.4}],gesturesTools,chain);
 assert.deepEqual(steps.map(e=>e.index),[0,1]);
 for(const index of [-1,1.5,null,Infinity,'1'])assert.throws(()=>prepareSteps([{tool:'tap',index,arguments:{x:0,y:0},delay:0}],gesturesTools,chain),/index/);
});
