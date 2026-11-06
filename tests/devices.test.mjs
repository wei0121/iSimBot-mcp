import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDevices, parseSimulatorModels, IDBClient } from '../dist/operation/idb-client.js';
test('device list accepts real idb JSON lines, legacy arrays, single and empty outputs', () => {
  const a = { udid: 'a', name: 'Phone', state: 'Booted', type: 'simulator', runtime: null, model: null };
  const b = { udid: 'b', name: 'Tablet', state: 'Shutdown', type: 'simulator', runtime: null, model: null };
  assert.deepEqual(parseDevices(JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n'), [a, b]);
  assert.deepEqual(parseDevices(JSON.stringify([a, b])), [a, b]);
  assert.deepEqual(parseDevices(JSON.stringify(a)), [a]);
  assert.deepEqual(parseDevices('  '), []);
  assert.throws(() => parseDevices('invalid'));
});

test('device listings preserve runtime and exclude non-addressable host entries', () => {
  const raw = [{udid:'phone',name:'Phone',state:'Booted',type:'simulator',os_version:'iOS 27.0'},
    {name:'Mac',type:'mac'},{udid:null,name:'Mac'},null,{udid:'  ',name:'Invalid'},
    {udid:'unknown',name:'Mac',type:'mac'},{udid:' UNKNOWN ',name:'Invalid'},
    {udid:'host-123',name:'Host',type:'macOS'},{udid:'null',name:'Invalid'},
    {udid:'physical',name:'iPhone',state:'Booted',type:'device',os_version:null}];
  const result=parseDevices(JSON.stringify(raw));
  assert.deepEqual(result.map(d=>[d.udid,d.runtime]),[['phone','iOS 27.0'],['physical',null]]);
  assert.equal(parseDevices(JSON.stringify({...raw[0],os_version:'iOS 26.2'}))[0].runtime,'iOS 26.2');
  assert.equal(parseDevices(JSON.stringify({udid:'real-sim',name:'Mac',type:'simulator'}))[0].name,'Mac');
});

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const inventory={devicetypes:[{identifier:'type.phone17',name:'iPhone 17'},{identifier:'type.phone18pro',name:'iPhone 18 Pro'}],devices:{'iOS-27':[
 {udid:'ABC',name:'My test phone',deviceTypeIdentifier:'type.phone17'},
 {udid:'DEF',name:'My test phone',deviceTypeIdentifier:'type.phone18pro'},
 {udid:'GHI',name:'iPhone 17',deviceTypeIdentifier:'missing.type'},
]}};
test('simulator model uses UDID/type metadata rather than duplicate or renamed display names',()=>{
 const result=parseSimulatorModels(JSON.stringify(inventory));
 assert.equal(result.get('ABC'),'iPhone 17');assert.equal(result.get('DEF'),'iPhone 18 Pro');assert.equal(result.has('GHI'),false);
 assert.throws(()=>parseSimulatorModels('{}'),/Invalid/);
});
test('device listing enriches real model metadata and degrades to null when simctl is unavailable',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'isimbot-device-model-')),oldPath=process.env.PATH;
 t.after(()=>{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});});
 const raw=[{udid:'abc',name:'My test phone',type:'simulator',state:'Booted',os_version:'iOS 27.0'},
  {udid:'ghi',name:'iPhone 17',type:'simulator',state:'Shutdown'},
  {udid:'physical',name:'Real iPhone',type:'device',state:'Booted'}];
 writeFileSync(join(dir,'idb'),`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(raw))});\n`,{mode:0o755});
 const xcrun=join(dir,'xcrun');
 writeFileSync(xcrun,`#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(inventory))});\n`,{mode:0o755});
 process.env.PATH=`${dir}:${oldPath}`;
 const client=new IDBClient();let devices=await client.listDevices();
 assert.deepEqual(devices.map(d=>d.model),['iPhone 17',null,null]);
 assert.equal(devices[0].name,'My test phone');assert.equal(devices[0].runtime,'iOS 27.0');
 writeFileSync(xcrun,`#!${process.execPath}\nprocess.exitCode=1;\n`,{mode:0o755});
 devices=await client.listDevices();assert.equal(devices.length,3);assert.ok(devices.every(d=>d.model===null));
});
