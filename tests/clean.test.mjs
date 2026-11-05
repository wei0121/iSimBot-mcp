import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { cleanCache } from '../dist/storage/clean-cache.js';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';
const managed='isimbot-1793877566165-11111111-1111-1111-1111-111111111111.png';
function fixture(t) {
 const dir=mkdtempSync(join(tmpdir(),'isimbot-clean-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=(path,data='data')=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,data);return path;};
 return {dir,file};
}
test('clean removes only completed managed screenshots and preserves user data',t=>{
 const {dir,file}=fixture(t), settings=new ScreenshotSettingsStore(join(dir,'config','screenshot.json'));
 const removed=file(join(dir,'config','screenshots',managed),'12345');
 const preserved=['screenshot.json','screenshots/custom.png','screenshots/.pending-1111.png','recordings/video.mp4','observations/session/session.json'].map(n=>file(join(dir,'config',n)));
 const other=file(join(dir,'formal','screenshots',managed));
 const result=cleanCache(settings);
 assert.deepEqual(result,{deletedFiles:1,freedBytes:5,skippedEntries:3});
 assert.equal(existsSync(removed),false);
 for(const path of [...preserved,other])assert.ok(existsSync(path),path);
 assert.equal(cleanCache(settings).deletedFiles,0);
});
test('local cleanup preserves installation and download caches',t=>{
 const {dir,file}=fixture(t), root=join(dir,'.runtime');
 const settings=new ScreenshotSettingsStore(join(root,'state','screenshot.json'));
 file(join(root,'ready'));
 const installed=file(join(root,'node','bin','node'));
 const cached=file(join(root,'cache','npm','blob'));
 const outside=file(join(dir,'external','keep'));
 symlinkSync(join(dir,'external'),join(root,'cache','linked-directory'));
 symlinkSync(outside,join(root,'cache','linked-file'));
 // Cleanup also works before a configuration/state directory has been created.
 const result=cleanCache(settings);
 assert.equal(result.deletedFiles,0);assert.equal(result.skippedEntries,0);
 assert.equal(existsSync(cached),true);assert.ok(existsSync(installed));assert.equal(readFileSync(outside,'utf8'),'data');
});
test('clean refuses linked config roots and skips linked screenshot directories',t=>{
 const {dir,file}=fixture(t), outside=file(join(dir,'external',managed));
 symlinkSync(join(dir,'external'),join(dir,'linked-root'));
 assert.throws(()=>cleanCache(new ScreenshotSettingsStore(join(dir,'linked-root','screenshot.json'))),/symbolic link/);
 mkdirSync(join(dir,'config'));
 symlinkSync(join(dir,'external'),join(dir,'config','screenshots'));
 assert.equal(cleanCache(new ScreenshotSettingsStore(join(dir,'config','screenshot.json'))).deletedFiles,0);
 assert.ok(existsSync(outside));
});
test('CLI clean uses its configured storage, reports results and is harmless on an empty cache',t=>{
 const {dir,file}=fixture(t);file(join(dir,'screenshots',managed));file(join(dir,'screenshot.json'),'{}');
 const run=(...args)=>spawnSync(process.execPath,['dist/index.js',...args],{encoding:'utf8',env:{...process.env,ISIMBOT_CONFIG_DIR:dir}});
 const first=run('clean');assert.equal(first.status,0,first.stderr);assert.match(first.stdout,/1 files/);
 assert.equal(existsSync(join(dir,'screenshots',managed)),false);assert.equal(readFileSync(join(dir,'screenshot.json'),'utf8'),'{}');
 assert.match(run('clean').stdout,/0 files/);assert.match(run('--help').stdout,/isimbot clean/);
 assert.equal(run('clean','all').status,1);
});

test('clean deletes completed videos and archived observation images, preserving JSON and active media',t=>{
 const {dir,file}=fixture(t), settings=new ScreenshotSettingsStore(join(dir,'screenshot.json'));
 const video=file(join(dir,'recordings','2026-11-05T12-30-00-000Z-11111111-1111-1111-1111-111111111111.mp4'));
 const archive=file(join(dir,'observations','observations.json'),JSON.stringify([{timeline:'session_11111111',events:[]}]));
 const observing=file(join(dir,'observations','observing.json'),JSON.stringify([{timeline:'session_22222222',events:[]}]));
 const image=file(join(dir,'observations','images','session_11111111-capture-000000-0.png'));
 const active=file(join(dir,'observations','images','session_22222222-capture-000000-0.jpeg'));
 const unknown=file(join(dir,'observations','images','session_33333333-capture-000000-0.png'));
 const pending=file(join(dir,'recordings','.pending-video.mp4'));
 const archiveText=readFileSync(archive,'utf8'), observingText=readFileSync(observing,'utf8');
 assert.equal(cleanCache(settings).deletedFiles,2);
 for(const path of [video,image])assert.equal(existsSync(path),false);
 for(const path of [active,unknown,pending])assert.ok(existsSync(path));
 assert.equal(readFileSync(archive,'utf8'),archiveText);assert.equal(readFileSync(observing,'utf8'),observingText);
});
test('clean cancels before deleting media when observation indices cannot be read safely',t=>{
 const {dir,file}=fixture(t), settings=new ScreenshotSettingsStore(join(dir,'screenshot.json'));
 const image=file(join(dir,'screenshots',managed));
 file(join(dir,'observations','observations.json'),'invalid json');
 assert.throws(()=>cleanCache(settings));assert.ok(existsSync(image));
});
