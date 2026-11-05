import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ScreenshotSettingsStore, historyDirectory } from '../setting/screenshot-settings.js';

const managedScreenshot = /^isimbot-\d{13}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.png$/;

// Never follow directory or file symlinks. Keep pending screenshots in use by MCP.
export function cleanCache(settings = new ScreenshotSettingsStore()) {
  const result = { deletedFiles: 0, freedBytes: 0, skippedEntries: 0 };
  const configDirectory = dirname(settings.path);
  const regularDirectory = (path: string) => {
    try { return lstatSync(path).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const removeFile = (path: string) => {
    try {
      const info = lstatSync(path);
      if (!info.isFile()) { result.skippedEntries++; return; }
      unlinkSync(path);
      result.deletedFiles++; result.freedBytes += info.size;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  const cleanDirectory = (path: string, recursive: boolean) => {
    if (!regularDirectory(path)) { if (existsSync(path)) result.skippedEntries++; return; }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isSymbolicLink()) { result.skippedEntries++; continue; }
      if (recursive && entry.isDirectory()) cleanDirectory(target, true);
      else if (entry.isFile() && (recursive || managedScreenshot.test(entry.name))) removeFile(target);
      else result.skippedEntries++;
    }
  };
  if (!regularDirectory(configDirectory)) {
    if (existsSync(configDirectory)) throw new Error('Cache cleanup requires a regular configuration directory, not a symbolic link.');
  }
  cleanDirectory(historyDirectory(settings), false);
  // Local launchers use <project>/.runtime/state. Only this marked private
  // runtime has an installation cache; never touch global npm/Homebrew caches.
  const runtime = dirname(configDirectory);
  if (basename(configDirectory) === 'state' && basename(runtime) === '.runtime' && regularDirectory(runtime)) {
    const ready = join(runtime, 'ready');
    if (existsSync(ready) && lstatSync(ready).isFile()) cleanDirectory(join(runtime, 'cache'), true);
  }
  return result;
}
