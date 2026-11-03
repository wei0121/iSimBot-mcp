const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const SOURCE = 'wei0121/iSimBot-mcp';

function releaseContext(event, repository = SOURCE) {
  const pr = event.pull_request;
  if (repository !== SOURCE || event.action !== 'closed' || !pr?.merged || pr.base?.ref !== 'main' ||
      pr.base?.repo?.full_name !== SOURCE || pr.head?.repo?.full_name !== SOURCE) throw Error('Only merged same-repository release PRs targeting main can publish.');
  const match = /^release\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(pr.head.ref);
  if (!match || !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha || '')) throw Error('Expected release/vX.Y.Z and a merge commit SHA.');
  return {tag:match[1],sha:pr.merge_commit_sha,version:match[1].slice(1)};
}
async function optional(action) {
  try { return (await action()).data; } catch(e) { if(e.status===404)return null; throw e; }
}
async function ensureTag(github, {tag,sha}) {
  const repo={owner:'wei0121',repo:'iSimBot-mcp'};
  const ref=await optional(()=>github.rest.git.getRef({...repo,ref:`tags/${tag}`}));
  if (!ref) { await github.rest.git.createRef({...repo,ref:`refs/tags/${tag}`,sha});return; }
  let object=ref.object;
  for(let depth=0;object.type==='tag'&&depth<10;depth++) object=(await github.rest.git.getTag({...repo,tag_sha:object.sha})).data.object;
  if(object.type!=='commit'||object.sha!==sha)throw Error(`Existing ${tag} points elsewhere; refusing to move it.`);
}
function verifyAssets(dir, tag) {
  const version=tag.slice(1), archive=`isimbot-mcp-${version}.tar.gz`;
  const checksum=fs.readFileSync(path.join(dir,'SHA256SUMS'),'utf8').trim();
  const match=/^([a-f0-9]{64})\s+(\S+)$/.exec(checksum);
  if(!match||match[2]!==archive)throw Error('Invalid release checksum manifest');
  const sha=crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,archive))).digest('hex');
  const formula=fs.readFileSync(path.join(dir,'isimbot-mcp.rb'),'utf8');
  if(sha!==match[1]||!formula.includes(`  sha256 "${sha}"`)||!formula.includes(`  version "${version}"`)||
     !formula.includes(`  url "https://github.com/${SOURCE}/releases/download/${tag}/${archive}"`)) throw Error('Release archive, checksum and formula disagree');
  return formula;
}
async function publish(github, release, dir) {
  const repo={owner:'wei0121',repo:'iSimBot-mcp'};
  await ensureTag(github,release);
  let existing=await optional(()=>github.rest.repos.getReleaseByTag({...repo,tag:release.tag}));
  const names=[`isimbot-mcp-${release.version}.tar.gz`,'SHA256SUMS','isimbot-mcp.rb'];
  if(existing&&!existing.draft){
    // Reruns use the immutable published assets, not a freshly rebuilt tarball.
    fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
    execFileSync('gh',['release','download',release.tag,'--repo',SOURCE,'--dir',dir,...names.flatMap(n=>['--pattern',n])],{stdio:'inherit'});
    verifyAssets(dir,release.tag);return existing.html_url;
  }
  verifyAssets(dir,release.tag);
  const notes=fs.readFileSync(path.join(dir,'release-notes.md'),'utf8');
  if(!existing)existing=(await github.rest.repos.createRelease({...repo,tag_name:release.tag,target_commitish:release.sha,name:`iSimBot-MCP ${release.version}`,body:notes,draft:true})).data;
  else {
    // Only an unpublished draft can be repaired after an interrupted upload.
    for(const asset of existing.assets)await github.rest.repos.deleteReleaseAsset({...repo,asset_id:asset.id});
    await github.rest.repos.updateRelease({...repo,release_id:existing.id,body:notes});
  }
  for(const name of names){
    const bytes=fs.readFileSync(path.join(dir,name));
    await github.rest.repos.uploadReleaseAsset({...repo,release_id:existing.id,name,data:bytes,headers:{'content-type':'application/octet-stream','content-length':bytes.length}});
  }
  const published=(await github.rest.repos.updateRelease({...repo,release_id:existing.id,draft:false,make_latest:'true'})).data;
  return published.html_url;
}
module.exports={releaseContext,ensureTag,verifyAssets,publish};
