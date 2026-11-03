"""Launch pinned fb-idb with installation-private connection state.

fb-idb 1.7.8 hardcodes /tmp/idb and imports its constants by value. Configure
those constants before importing the CLI; never modify installed third-party code.
"""
import hashlib
import os
from pathlib import Path
import stat
import sys


def configure(runtime: Path) -> Path:
    runtime = runtime.resolve()
    installation = (runtime / 'installation-id').read_text().strip()
    if not installation:
        raise RuntimeError('Missing local installation identity; run local-setup.sh')
    identity = hashlib.sha256(f'{runtime}:{installation}'.encode()).hexdigest()[:20]
    # macOS Unix sockets have a short path limit; checkout paths can be long.
    base = Path('/tmp') / f'isbl-{os.getuid()}-{identity}'
    base.mkdir(mode=0o700, exist_ok=True)
    info = base.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError(f'Refusing unsafe local idb state directory: {base}')

    from idb.common import constants
    constants.BASE_IDB_FILE_PATH = str(base)
    constants.IDB_PID_PATH = str(base / 'pid')
    constants.IDB_LOGS_PATH = str(base / 'logs')
    constants.IDB_STATE_FILE_PATH = str(base / 'state')
    # An inherited explicit companion address would bypass the isolated state.
    for name in ('IDB_COMPANION', 'IDB_COMPANION_TLS', 'IDB_COMPANION_TMPDIR'):
        os.environ.pop(name, None)
    os.environ['IDB_COMPANION_PATH'] = str(runtime / 'idb-companion/idb_companion')
    return base


def main() -> None:
    configure(Path(__file__).resolve().parent)
    from idb.cli.main import main as idb_main
    sys.exit(idb_main())


if __name__ == '__main__':
    main()
