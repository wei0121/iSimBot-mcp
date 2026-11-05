import { existsSync, lstatSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ScreenshotSettingsStore, historyDirectory } from '../setting/screenshot-settings.js';

const managedScreenshot = /^isimbot-\d{13}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.png$/;

const managedRecording = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.mp4$/;
const observationImage = /^(session_[0-9a-f]{8})-capture-\d{6}-\d+\.(png|jpeg)$/;

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
  const cleanDirectory = (path: string, matches: (name: string) => boolean) => {
    if (!regularDirectory(path)) { if (existsSync(path)) result.skippedEntries++; return; }
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isSymbolicLink()) { result.skippedEntries++; continue; }
      if (entry.isFile() && matches(entry.name)) removeFile(target);
      else result.skippedEntries++;
    }
  };
  if (!regularDirectory(configDirectory)) {
    if (existsSync(configDirectory)) throw new Error('Cache cleanup requires a regular configuration directory, not a symbolic link.');
  }
  const observations = join(configDirectory, 'observations');
  const timelines = (filename: string): Set<string> => {
    if (!regularDirectory(observations)) return new Set();
    const path = join(observations, filename);
    try {
      if (!lstatSync(path).isFile()) throw new Error('Observation index must be a regular file.');
      const values = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(values) || values.some(value => !value || !/^session_[0-9a-f]{8}$/.test(value.timeline))) throw new Error('Invalid observation index; cleanup cancelled.');
      return new Set(values.map(value => value.timeline));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
  };
  // Read both indices before deleting anything; only archived session media qualify.
  const archived = timelines('observations.json');
  const observing = timelines('observing.json');
  cleanDirectory(historyDirectory(settings), name => managedScreenshot.test(name));
  cleanDirectory(join(configDirectory, 'recordings'), name => managedRecording.test(name));
  if (regularDirectory(observations)) cleanDirectory(join(observations, 'images'), name => {
    const match = observationImage.exec(name);
    return !!match && archived.has(match[1]) && !observing.has(match[1]);
  });
  return result;
}
