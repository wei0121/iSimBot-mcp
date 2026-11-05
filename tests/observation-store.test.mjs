import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { ObservationStore } from '../dist/storage/observation-store.js';
const run=promisify(execFile);
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'isimbot-observation-store-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,store:new ObservationStore(dir)};}
function record(timeline){return {timeline,udid:'device',bundleId:'test.app',startedAt:1,expireAt:1001,captureInterval:0.5,events:[{timeline,tool:'tap',arguments:{x:1,y:1},time:2,delay:2,duration:0.1},{timeline,tool:'capture',arguments:{},time:1,delay:1,duration:0.2,capture:{images:[{path:'/example/image.png',mimeType:'image/png',sizeBytes:10}],metadata:{elements:[]}}}]};}
test('root arrays retain other sessions, sort events stably and retain capture references; archive is idempotent',t=>{
 const {dir,store}=fixture(t);const a=record('session_11111111'),b=record('session_22222222');
 store.save(a,'observing');store.save(b,'observing');
 assert.ok(Array.isArray(JSON.parse(readFileSync(store.observingPath))));
 assert.deepEqual(store.find(a.timeline).events.map(e=>e.time),[1,2]);
 store.save(a,'archived');store.save(a,'archived');store.save(a,'observing');
 assert.equal(store.lookup(a.timeline).observing,false);assert.equal(store.lookup(b.timeline).observing,true);
 for (const path of [store.observingPath,store.observationsPath]) assert.ok(JSON.parse(readFileSync(path)).every(session=>!Object.hasOwn(session,'active')));
 assert.equal(store.find(a.timeline).events[0].capture.images[0].path,'/example/image.png');
 assert.equal(JSON.parse(readFileSync(store.observationsPath)).length,1);
 assert.equal(JSON.parse(readFileSync(store.observingPath)).length,1);
 assert.deepEqual(readdirSync(dir).sort(),['observations.json','observing.json']);
});
test('malformed JSON is never overwritten during an update',t=>{
 const {store}=fixture(t);store.save(record('session_11111111'),'observing');
 const before=readFileSync(store.observingPath,'utf8');writeFileSync(store.observationsPath,'{"timelines":{}}');
 assert.throws(()=>store.save(record('session_22222222'),'observing'),/array/);
 assert.equal(readFileSync(store.observingPath,'utf8'),before);assert.equal(readFileSync(store.observationsPath,'utf8'),'{"timelines":{}}');
});
test('concurrent processes merge different timelines without lost updates',async t=>{
 const {dir,store}=fixture(t);
 const module=new URL('../dist/storage/observation-store.js',import.meta.url).href;
 await Promise.all(Array.from({length:6},(_,i)=>run(process.execPath,['--input-type=module','-e',`import {ObservationStore} from ${JSON.stringify(module)};const store=new ObservationStore(${JSON.stringify(dir)});const value=${JSON.stringify(record('session_'+String(i).padStart(8,'0')))};store.save(value,'observing');store.save(value,'archived');`])));
 assert.equal(JSON.parse(readFileSync(store.observationsPath)).length,6);assert.deepEqual(JSON.parse(readFileSync(store.observingPath)),[]);
});

test('expiry scan selects all overdue sessions, excludes history and future sessions',t=>{
 const {store}=fixture(t);
 store.save(record('session_11111111'),'observing');
 store.save({...record('session_22222222'),expireAt:2001},'observing');
 store.save(record('session_33333333'),'archived');
 assert.deepEqual(store.expired(1000),[]);
 assert.deepEqual(store.expired(1001).map(s=>s.timeline),['session_11111111']);
 assert.equal(store.expired(2001).length,2);
});
