import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('local idb isolates identities, clears external routing, and refuses unsafe state directories',()=>{
 const python=existsSync('.runtime/python/bin/python3')?resolve('.runtime/python/bin/python3'):'python3';
 const result=spawnSync(python,['-I','-'],{encoding:'utf8',input:`
import os, runpy, sys, tempfile, types, shutil
from pathlib import Path
source = runpy.run_path(${JSON.stringify(resolve('scripts/local-idb.py'))})
constants = types.ModuleType('idb.common.constants')
common = types.ModuleType('idb.common'); common.constants = constants
sys.modules['idb'] = types.ModuleType('idb')
sys.modules['idb.common'] = common
sys.modules['idb.common.constants'] = constants
paths = set()
with tempfile.TemporaryDirectory(prefix='isimbot isolation ') as root:
    runtime = Path(root).resolve() / '.runtime'; runtime.mkdir()
    token = runtime / 'installation-id'; token.write_text('first-install')
    os.environ['IDB_COMPANION'] = 'localhost:1234'
    os.environ['IDB_COMPANION_PATH'] = '/opt/homebrew/idb_companion'
    os.environ['IDB_COMPANION_TLS'] = '1'
    os.environ['IDB_COMPANION_TMPDIR'] = '/tmp/shared'
    try:
        first = source['configure'](runtime); paths.add(first)
        assert first != Path('/tmp/idb')
        assert source['configure'](runtime) == first
        assert constants.IDB_STATE_FILE_PATH == str(first / 'state')
        assert constants.IDB_LOGS_PATH == str(first / 'logs')
        assert constants.IDB_PID_PATH == str(first / 'pid')
        assert constants.BASE_IDB_FILE_PATH == str(first)
        assert len(str(first / ('A'*36 + '_companion.sock')).encode()) < 104
        assert os.environ['IDB_COMPANION_PATH'] == str(runtime / 'idb-companion/idb_companion')
        assert 'IDB_COMPANION' not in os.environ
        assert 'IDB_COMPANION_TLS' not in os.environ
        assert 'IDB_COMPANION_TMPDIR' not in os.environ
        token.write_text('second-install')
        second = source['configure'](runtime); paths.add(second)
        assert first != second
        other = Path(root) / 'other'; other.mkdir(); (other/'installation-id').write_text('second-install')
        third = source['configure'](other); paths.add(third)
        assert second != third
        second.rmdir(); second.symlink_to(first, target_is_directory=True)
        try:
            source['configure'](runtime)
            raise AssertionError('symlink accepted')
        except RuntimeError: pass
        second.unlink(); second.mkdir(mode=0o755)
        try:
            source['configure'](runtime)
            raise AssertionError('shared permissions accepted')
        except RuntimeError: pass
    finally:
        for path in paths:
            if path.is_symlink(): path.unlink()
            else: shutil.rmtree(path)
`});
 assert.equal(result.status,0,result.stderr);
});
