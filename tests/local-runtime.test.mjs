import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

test('local launcher uses project runtime and state, forwards arguments, and rejects incomplete installs',t=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'isimbot project ')));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'scripts'));
  for(const name of ['local-env.sh','isimbot-local','local-npm'])copyFileSync(`scripts/${name}`,join(dir,'scripts',name));
  const launch=(name,...args)=>spawnSync('/bin/bash',[join(dir,'scripts',name),...args],{cwd:'/',encoding:'utf8',env:{...process.env,PATH:'/usr/bin:/bin',ISIMBOT_CONFIG_DIR:'/not-local',ISIMBOT_SERVER_NAME:'isimbot'}});
  const missing=launch('isimbot-local');assert.equal(missing.status,1);assert.match(missing.stderr,/local-setup/);
  mkdirSync(join(dir,'.runtime/node/bin'),{recursive:true});mkdirSync(join(dir,'dist'));
  writeFileSync(join(dir,'dist/index.js'),'');writeFileSync(join(dir,'.runtime/ready'),'ready');
  writeFileSync(join(dir,'.runtime/node/bin/node'),'#!/bin/bash\nprintf "%s\\n" "$ISIMBOT_SERVER_NAME" "$ISIMBOT_CONFIG_DIR" "$ISIMBOT_LAUNCHER" "$PATH" "$@"\n',{mode:0o755});
  const result=launch('isimbot-local','--help');assert.equal(result.status,0);
  const lines=result.stdout.trimEnd().split('\n');
  assert.equal(lines[0],'isimbot-local');assert.equal(lines[1],join(dir,'.runtime/state'));
  assert.equal(lines[2],join(dir,'scripts/isimbot-local'));
  assert.ok(lines[3].startsWith(join(dir,'.runtime/node/bin')));
  assert.ok(!lines[3].includes('homebrew'));
  assert.deepEqual(lines.slice(4),[join(dir,'dist/index.js'),'--help']);
  const npm=launch('local-npm','run','build');assert.equal(npm.status,0);
  assert.ok(npm.stdout.endsWith(`${join(dir,'.runtime/node/lib/node_modules/npm/bin/npm-cli.js')}\nrun\nbuild\n`));
  mkdirSync(join(dir,'.runtime/install.lock'));
  assert.match(launch('isimbot-local').stderr,/setup is running/);
});
