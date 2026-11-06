import{test}from'node:test';import assert from'node:assert/strict';
import{tools}from'../dist/mcp/registry.js';import{IDBClient}from'../dist/operation/idb-client.js';
import{prepareSteps}from'../dist/common/operation.js';import{deviceControlActions,textSizes}from'../dist/common/device-control.js';
import{mkdtempSync,writeFileSync,readFileSync,rmSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
const control=tools.find(t=>t.definition.name==='device_control');

test('device_control validates action-specific payloads before every chain side effect',async()=>{
 const calls=[];const client=new Proxy({}, {get:(_,method)=>async(...args)=>calls.push([method,...args])});
 const bad=[{action:'unknown',payload:{}},{action:'get_settings',payload:null},{action:'get_settings',payload:[]},{action:'get_settings',payload:{deviceId:'other'}},{action:'get_settings',payload:{appearance:'dark'}},{action:'set_text_size',payload:{size:'big'}},{action:'rotate',payload:{orientation:'left'}},{action:'set_appearance',payload:{appearance:'dark',size:'large'}},{action:'set_location',payload:{latitude:91,longitude:0}},{action:'set_location',payload:{latitude:1}},{action:'send_notification',payload:{bundleId:'app.id',notification:{}}},{action:'send_notification',payload:{bundleId:'app.id',notification:{aps:[]}}},{action:'send_notification',payload:{bundleId:'--help',notification:{aps:{}}}},{action:'list_notifications',payload:{bundleId:'app.id',limit:101}},{action:'get_settings',payload:{},size:'large'}];
 for(const args of bad){await assert.rejects(control.execute(client,args,{}));await assert.rejects(tools.find(t=>t.definition.name==='operation_chain').execute(client,{steps:[{tool:'press_button',arguments:{button:'home'}},{tool:'device_control',arguments:args}]},{}));}
 const huge={action:'send_notification',payload:{bundleId:'app.id',notification:{aps:{alert:'中'.repeat(2000)}}}};
 await assert.rejects(control.execute(client,huge,{}),e=>e.details.code==='NOTIFICATION_TOO_LARGE');assert.deepEqual(calls,[]);
});
test('all seven actions dispatch typed payloads, paginate retained notifications, and preserve accepted/confirmed semantics',async()=>{
 const calls=[];const client={getDeviceSettings:async()=>({settings:{appearance:'light'}}),setDeviceTextSize:async s=>(calls.push(['size',s]),s),setDeviceAppearance:async s=>(calls.push(['appearance',s]),s),rotate:async s=>calls.push(['rotate',s]),setLocation:async(...v)=>calls.push(['location',...v]),sendNotification:async(...v)=>calls.push(['send',...v]),listNotifications:async()=>Array.from({length:102},(_,i)=>({identifier:String(i)}))};
 assert.equal((await control.execute(client,{action:'get_settings',payload:{}},{})).settings.appearance,'light');
 for(const size of textSizes)assert.equal((await control.execute(client,{action:'set_text_size',payload:{size}},{})).confirmed,true);
 assert.equal((await control.execute(client,{action:'set_appearance',payload:{appearance:'dark'}},{})).appearance,'dark');
 await control.execute(client,{action:'rotate',payload:{orientation:'landscape_left'}},{});
 const location=await control.execute(client,{action:'set_location',payload:{latitude:1,longitude:2}},{});assert.equal(location.accepted,true);assert.equal(location.confirmed,undefined);
 const notification={aps:{alert:{title:'中文🙂',body:'literal $(cmd)'}},custom:[1,true,null]};assert.equal((await control.execute(client,{action:'send_notification',payload:{bundleId:'app.id',notification}},{})).accepted,true);assert.deepEqual(calls.at(-1),['send','app.id',notification]);
 const page=await control.execute(client,{action:'list_notifications',payload:{bundleId:'app.id',offset:100,limit:2}},{});assert.equal(page.total,102);assert.equal(page.nextOffset,null);assert.deepEqual(page.notifications.map(n=>n.identifier),['100','101']);
 const steps=prepareSteps([{tool:'device_control',arguments:{action:'rotate',payload:{orientation:'portrait'}},delay:0},{tool:'tap',arguments:{x:1,y:2}}],tools,'chain_aabbccdd',{minDelay:{device_control:1,rotate:2}});assert.equal(steps[1].delay,2);
});
test('system settings and notifications use literal argv, confirm readback, and expose partial query failures',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'isimbot-device-control-')),oldPath=process.env.PATH,log=join(dir,'argv'),mode=join(dir,'mode');writeFileSync(mode,'ok');
 const script=`#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');const mode=fs.readFileSync(${JSON.stringify(mode)},'utf8');
if(a[0]==='simctl'){
 const key=a[3],path=${JSON.stringify(dir)}+'/'+key;if(a[4])fs.writeFileSync(path,a[4]);else console.log((mode==='readfail'||mode==='partial'&&key==='content_size')?'unsupported':fs.existsSync(path)?fs.readFileSync(path,'utf8'):key==='appearance'?'light':'large');
}else if(a[0]==='rotation')console.log('{"orientation":"PORTRAIT"}');
else if(a[0]==='notification'&&a[1]==='list'){
 const bundle=a.at(-1);console.log(JSON.stringify({bundle_id:bundle,identifier:'old',title:'T',subtitle:'',body:'中文\\nbody',thread_identifier:'x',date:1}));console.log(JSON.stringify({bundle_id:mode==='mismatch'?'other':bundle,identifier:'new',title:'N',subtitle:'',body:'B',thread_identifier:'',date:2}));
}
`;
 for(const name of['idb','xcrun'])writeFileSync(join(dir,name),script,{mode:0o755});process.env.PATH=`${dir}:${oldPath}`;t.after(()=>{process.env.PATH=oldPath;rmSync(dir,{recursive:true,force:true});});
 const client=new IDBClient();client.udid='selected-device';
 assert.equal(await client.setDeviceAppearance('dark'),'dark');assert.equal(await client.setDeviceTextSize('accessibility-large'),'accessibility-large');
 const notification={aps:{alert:'中文 " $(touch /tmp/never)'}};await client.sendNotification('app.id',notification);
 const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(calls.at(-1),['notification','send','--udid','selected-device','--','app.id',JSON.stringify(notification)]);
 const list=await client.listNotifications('app.id');assert.deepEqual(list.map(n=>n.identifier),['new','old']);assert.equal(list[1].body,'中文\nbody');assert.equal(list[0].deliveredAt,2);
 writeFileSync(mode,'partial');const settings=await client.getDeviceSettings();assert.equal(settings.partial,true);assert.equal(settings.settings.textSize,null);assert.equal(settings.settings.appearance,'dark');assert.equal(settings.capabilities.textSize.readable,false);assert.match(settings.errors.textSize,/unsupported/);assert.deepEqual(settings.actions,deviceControlActions);
 writeFileSync(mode,'readfail');await assert.rejects(client.setDeviceAppearance('light'),e=>e.details.code==='DEVICE_SETTING_FAILED'&&/may have applied/.test(e.message));
 writeFileSync(mode,'mismatch');await assert.rejects(client.listNotifications('app.id'),/Invalid/);
 const count=readFileSync(log,'utf8').length;await assert.rejects(client.setDeviceAppearance('auto'));assert.equal(readFileSync(log,'utf8').length,count);
});

import{Client}from'@modelcontextprotocol/sdk/client/index.js';import{InMemoryTransport}from'@modelcontextprotocol/sdk/inMemory.js';
import{createServer}from'../dist/mcp/server.js';import{ScreenshotSettingsStore}from'../dist/setting/screenshot-settings.js';
test('MCP keeps deviceId at top level, routes ID/name aliases, serializes one device and allows another device concurrently',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'isimbot-control-routing-')),events=[];let release,entered;
 const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 class Fake{
  id=null;getConnectedDevice(){return this.id}async connect(id){this.id=id}
  async listDevices(){return ['A','B'].map(udid=>({udid,name:'Phone '+udid,type:'simulator',state:'Booted'}))}
  async getDeviceSettings(){return {settings:{device:this.id}}}
  async setDeviceAppearance(value){events.push([this.id,value]);if(this.id==='A'&&value==='dark'){entered();await gate}return value}
 }
 const server=createServer(new Fake(),new ScreenshotSettingsStore(join(dir,'settings.json')),()=>new Fake()),client=new Client({name:'test',version:'1'});const[a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 t.after(async()=>{release();await client.close();await server.close();rmSync(dir,{recursive:true,force:true})});
 const call=async(name,args)=>{const response=await client.callTool({name,arguments:args});return {response,value:response.structuredContent??JSON.parse(response.content[0].text)}};
 const schema=(await client.listTools()).tools.find(t=>t.name==='device_control').inputSchema;assert.ok(schema.properties.deviceId);assert.equal(schema.properties.payload.properties.deviceId,undefined);
 const devices=(await call('list_devices',{})).value;
 assert.equal((await call('device_control',{deviceId:devices[0].deviceId,action:'get_settings',payload:{}})).value.settings.device,'A');
 assert.equal((await call('device_control',{deviceId:'Phone B',action:'get_settings',payload:{}})).value.settings.device,'B');
 assert.equal((await call('device_control',{action:'get_settings',payload:{}})).value.code,'DEVICE_REQUIRED');
 assert.equal((await call('device_control',{deviceId:'A',action:'get_settings',payload:{deviceId:'B'}})).response.isError,true);
 const first=call('device_control',{deviceId:'A',action:'set_appearance',payload:{appearance:'dark'}});await started;
 const second=call('device_control',{deviceId:'A',action:'set_appearance',payload:{appearance:'light'}});
 assert.equal((await call('device_control',{deviceId:'B',action:'set_appearance',payload:{appearance:'dark'}})).value.success,true);
 assert.deepEqual(events,[['A','dark'],['B','dark']]);release();await first;await second;assert.deepEqual(events.at(-1),['A','light']);
});
