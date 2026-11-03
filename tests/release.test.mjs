import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const {releaseContext,ensureTag,verifyAssets,publish}=createRequire(import.meta.url)('../.github/scripts/release.cjs');
const sha='a'.repeat(40),release={tag:'v1.0.5',version:'1.0.5',sha};
const event=()=>({action:'closed',pull_request:{merged:true,merge_commit_sha:sha,head:{ref:'release/v1.0.5',repo:{full_name:'wei0121/iSimBot-mcp'}},base:{ref:'main',repo:{full_name:'wei0121/iSimBot-mcp'}}}});
const absent=()=>{throw Object.assign(Error('missing'),{status:404});};
function assets(t){
 const dir=mkdtempSync(join(tmpdir(),'isimbot-release-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const bytes=Buffer.from('test archive');const hash=createHash('sha256').update(bytes).digest('hex');
 const formula=`  version "1.0.5"\n  sha256 "${hash}"\n  url "https://github.com/wei0121/iSimBot-mcp/releases/download/v1.0.5/isimbot-mcp-1.0.5.tar.gz"\n`;
 writeFileSync(join(dir,'isimbot-mcp-1.0.5.tar.gz'),bytes);writeFileSync(join(dir,'SHA256SUMS'),`${hash}  isimbot-mcp-1.0.5.tar.gz\n`);writeFileSync(join(dir,'isimbot-mcp.rb'),formula);writeFileSync(join(dir,'release-notes.md'),'Release notes');
 return {dir,formula};
}
test('release trigger accepts only merged same-repo exact version branches and fixes merge SHA',()=>{
 assert.deepEqual(releaseContext(event()),release);
 for(const mutate of [e=>e.action='opened',e=>e.pull_request.merged=false,e=>e.pull_request.base.ref='other',e=>e.pull_request.head.repo.full_name='fork/project',e=>e.pull_request.head.ref='release/1.0.5',e=>e.pull_request.head.ref='release/v1.0.5-extra',e=>e.pull_request.head.ref='release/v01.0.5',e=>e.pull_request.merge_commit_sha='main']){const e=event();mutate(e);assert.throws(()=>releaseContext(e));}
});
test('tag creation is pinned, repeatable, supports annotated tags and refuses conflicts',async()=>{
 const calls=[];let ref=null;
 const github={rest:{git:{getRef:async()=>ref?{data:ref}:absent(),createRef:async args=>{calls.push(args);ref={object:{type:'commit',sha:args.sha}};},getTag:async()=>({data:{object:{type:'commit',sha}}})}}};
 await ensureTag(github,release);await ensureTag(github,release);assert.equal(calls.length,1);assert.equal(calls[0].sha,sha);
 ref={object:{type:'tag',sha:'tag-object'}};await ensureTag(github,release);
 ref={object:{type:'commit',sha:'b'.repeat(40)}};await assert.rejects(ensureTag(github,release),/refusing to move/);
 github.rest.git.getRef=async()=>{throw Object.assign(Error('forbidden'),{status:403});};await assert.rejects(ensureTag(github,release),/forbidden/);
});
test('release assets must agree on version, URL and checksum',t=>{
 const {dir,formula}=assets(t);assert.equal(verifyAssets(dir,release.tag),formula);
 writeFileSync(join(dir,'isimbot-mcp-1.0.5.tar.gz'),'corrupt');assert.throws(()=>verifyAssets(dir,release.tag),/disagree/);
});
test('draft is published only after all assets upload and an interrupted draft can resume',async t=>{
 const {dir}=assets(t);let draft=null;let fail=true;const events=[];
 const github={rest:{git:{getRef:async()=>({data:{object:{type:'commit',sha}}})},repos:{
  getReleaseByTag:async()=>draft?{data:draft}:absent(),
  createRelease:async args=>{assert.equal(args.draft,true);draft={id:1,assets:[],draft:true};return {data:draft};},
  uploadReleaseAsset:async args=>{if(fail&&args.name==='SHA256SUMS')throw Error('interrupted');draft.assets.push({id:draft.assets.length+1,name:args.name});events.push('upload');},
  deleteReleaseAsset:async()=>events.push('delete'),
  updateRelease:async args=>{if(args.draft===false){events.push('publish');draft.draft=false;}return {data:{...draft,html_url:'release-url'}};},
 }}};
 await assert.rejects(publish(github,release,dir),/interrupted/);assert.equal(draft.draft,true);assert.ok(!events.includes('publish'));
 fail=false;await publish(github,release,dir);assert.equal(events.at(-1),'publish');assert.ok(events.includes('delete'));
});
test('public release rerun downloads and verifies published assets without overwriting them',async t=>{
 const {dir,formula}=assets(t);const target=join(dir,'rebuilt');mkdirSync(target);writeFileSync(join(target,'isimbot-mcp.rb'),'different build');
 const bin=join(dir,'bin');mkdirSync(bin);writeFileSync(join(bin,'gh'),`#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');const args=process.argv;const out=args[args.indexOf('--dir')+1];for(const name of ['isimbot-mcp-1.0.5.tar.gz','SHA256SUMS','isimbot-mcp.rb'])fs.copyFileSync(p.join(${JSON.stringify(dir)},name),p.join(out,name));`,{mode:0o755});
 const old=process.env.PATH;process.env.PATH=bin+':'+old;t.after(()=>{process.env.PATH=old;});
 const github={rest:{git:{getRef:async()=>({data:{object:{type:'commit',sha}}})},repos:{getReleaseByTag:async()=>({data:{draft:false,html_url:'existing-url'}})}}};
 assert.equal(await publish(github,release,target),'existing-url');assert.equal(readFileSync(join(target,'isimbot-mcp.rb'),'utf8'),formula);
});
test('preflight requires matching package/lock versions and a non-empty changelog before building', t => {
  const root=mkdtempSync(join(tmpdir(),'isimbot-version-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'scripts'));
  writeFileSync(join(root,'scripts/prepare-release.mjs'),readFileSync('scripts/prepare-release.mjs'));
  const pkg={version:'1.0.5'},lock={version:'1.0.5',packages:{'':{version:'1.0.5'}}};
  const save=()=>{writeFileSync(join(root,'package.json'),JSON.stringify(pkg));writeFileSync(join(root,'package-lock.json'),JSON.stringify(lock));};
  const check=tag=>spawnSync(process.execPath,[join(root,'scripts/prepare-release.mjs'),'--check'],{encoding:'utf8',env:{...process.env,RELEASE_TAG:tag,GITHUB_REPOSITORY:'wei0121/iSimBot-mcp'}});
  save();writeFileSync(join(root,'CHANGELOG.md'),'## 1.0.5\n\n- Change\n');
  assert.equal(check('v1.0.5').status,0);assert.notEqual(check('v1.0.6').status,0);
  lock.packages[''].version='1.0.4';save();assert.notEqual(check('v1.0.5').status,0);
  lock.packages[''].version='1.0.5';save();
  for(const changelog of ['## 1.0.4\n- Older\n','## 1.0.5\n\n## 1.0.4\n- Older\n']){
    writeFileSync(join(root,'CHANGELOG.md'),changelog);assert.notEqual(check('v1.0.5').status,0);
  }
});
