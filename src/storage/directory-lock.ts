import { mkdirSync, lstatSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function withDirectoryLock<T>(directory: string, action: () => T): T {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error('Storage directory must not be a symbolic link.');
    const lock = join(directory, '.lock');
    const deadline = Date.now() + 5000;
    while (true) {
      try { mkdirSync(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try { if (!lstatSync(lock).isDirectory()) throw new Error('Invalid storage lock.'); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') continue; throw failure; }
        if (Date.now() >= deadline) throw new Error('Storage is busy or has an abandoned .lock directory. Retry; if its owner process has exited, remove that lock before retrying.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); return action(); }
    finally { rmSync(lock, { recursive: true, force: true }); }
}
