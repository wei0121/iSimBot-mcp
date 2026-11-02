import { mkdirSync, lstatSync, readdirSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

function assertDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error('Screenshot history must be a regular directory, not a symbolic link.');
}
// Only completed files with our generated names belong to retention management.
const managedName = /^isimbot-\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;
export function pruneScreenshots(dir: string, limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid screenshot retention limit');
  try { assertDirectory(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  const files = readdirSync(dir, { withFileTypes: true })
    .filter(file => file.isFile() && managedName.test(file.name))
    .map(file => file.name).sort();
  let deleted = 0;
  for (const name of files.slice(0, Math.max(0, files.length - limit))) {
    try { unlinkSync(join(dir, name)); deleted++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return deleted;
}

// Pending captures are excluded from retention until their pixels have been read.
export function beginScreenshot(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertDirectory(dir);
  const id = randomUUID();
  const pending = join(dir, `.pending-${id}.png`);
  return {
    pending,
    commit(): string {
      const path = join(dir, `isimbot-${Date.now()}-${id}.png`);
      renameSync(pending, path);
      return path;
    },
    discard(): void { rmSync(pending, { force: true }); },
  };
}
