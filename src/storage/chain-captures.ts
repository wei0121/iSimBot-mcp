import { lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withDirectoryLock } from './directory-lock.js';
import type { StoredCapture } from './timeline-images.js';
import { ScreenshotSettingsStore } from '../setting/screenshot-settings.js';

export interface ChainCapture { index: number; timestamp: number | null; capture: StoredCapture }
export interface ChainCaptures { timeline: string; udid: string | null; eventCount: number; captures: ChainCapture[] }
export function chainDirectory(settings: ScreenshotSettingsStore) {
  return join(dirname(settings.path ?? new ScreenshotSettingsStore().path), 'chains');
}
function valid(record: ChainCaptures): boolean {
  return !!record && /^chain_[0-9a-f]{8}$/.test(record.timeline) && Number.isInteger(record.eventCount) && record.eventCount >= 0 && Array.isArray(record.captures)
    && record.captures.every(c => !!c && Number.isInteger(c.index) && c.index >= 0 && c.index < record.eventCount && (c.timestamp === null || Number.isFinite(c.timestamp)) && Array.isArray(c.capture?.images)
      && c.capture.images.every(image => image && typeof image.path === 'string' && ['image/png', 'image/jpeg'].includes(image.mimeType) && Number.isInteger(image.sizeBytes) && image.sizeBytes >= 0))
    && new Set(record.captures.map(c => c.index)).size === record.captures.length;
}
export class ChainCaptureStore {
  readonly path: string;
  constructor(readonly directory: string) { this.path = join(directory, 'captures.json'); }
  private read(): ChainCaptures[] {
    try {
      if (!lstatSync(this.path).isFile()) throw new Error('Chain catalog must be a regular JSON file.');
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      if (Array.isArray(value)) for (const record of value) if (record && Array.isArray(record.captures)) {
        record.captures = record.captures.map(({ time, ...capture }: any) => ({ ...capture, timestamp: capture.timestamp ?? null, ...(Number.isFinite(time) ? { legacyElapsedSeconds: time } : {}) }));
      }
      if (!Array.isArray(value) || value.some(v => !valid(v))) throw new Error('Invalid chain capture catalog.');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  list() { return withDirectoryLock(this.directory, () => this.read()); }
  find(timeline: string) { return withDirectoryLock(this.directory, () => this.read().find(v => v.timeline === timeline)); }
  save(record: ChainCaptures) {
    if (!valid(record)) throw new Error('Invalid chain capture record.');
    withDirectoryLock(this.directory, () => {
      const records = this.read();
      if (records.some(v => v.timeline === record.timeline)) throw new Error('Chain timeline already saved.');
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, JSON.stringify([...records, record]), { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.path); }
      finally { rmSync(temporary, { force: true }); }
    });
  }
}
