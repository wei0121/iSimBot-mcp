import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ScreenshotSettings {
  scale: number;
  format: 'png' | 'jpeg';
  quality: number;
  maxBytes: number;
  maxSavedImages: number;
}
export const defaults: ScreenshotSettings = {
  scale: 1, format: 'png', quality: 80, maxBytes: 1_000_000, maxSavedImages: 200,
};
export const settingsSchema = {
  maxSavedImages: { type: 'integer', minimum: 1, maximum: 10000, description: 'Maximum automatically saved screenshots, default 200. Updating this value immediately deletes oldest managed screenshots over the limit. Explicit output paths are excluded.' },
  scale: { type: 'number', minimum: 0.1, maximum: 4, description: 'Multiplier of original screenshot pixel dimensions: 1 = native, 2 = double, 0.5 = half, 0.2 = one fifth. Preserves aspect ratio, rounded to whole pixels.' },
  format: { type: 'string', enum: ['png', 'jpeg'], description: 'PNG (default) preserves UI text without lossy compression. JPEG can save bandwidth.' },
  quality: { type: 'integer', minimum: 40, maximum: 100, description: 'JPEG quality only; ignored for PNG.' },
  maxBytes: { type: 'integer', minimum: 10_000, maximum: 5_000_000, description: 'Maximum encoded image bytes BEFORE Base64 (~4/3 expansion). Returns an error if the requested scale cannot fit; never silently resizes.' },
};
export function validateSettings(value: unknown): Partial<ScreenshotSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Screenshot settings must be an object.');
  for (const [key, val] of Object.entries(value)) {
    if (key === 'scale') {
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0.1 || val > 4) throw new Error('scale must be between 0.1 and 4');
    } else if (key === 'format') {
      if (val !== 'png' && val !== 'jpeg') throw new Error('format must be png or jpeg');
    } else {
      const bounds = { maxSavedImages: [1, 10000], quality: [40, 100], maxBytes: [10_000, 5_000_000] }[key];
      if (!bounds || typeof val !== 'number' || !Number.isInteger(val) || val < bounds[0] || val > bounds[1]) throw new Error(`Invalid screenshot setting: ${key}`);
    }
  }
  return value;
}
export class ScreenshotSettingsStore {
  constructor(public readonly path = join(process.env.ISIMBOT_CONFIG_DIR || join(homedir(), '.config', 'isimbot'), 'screenshot.json')) {}
  read(): ScreenshotSettings {
    let text: string;
    try { text = readFileSync(this.path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults }; throw error; }
    return { ...defaults, ...validateSettings(JSON.parse(text)) };
  }
  update(patch: unknown): ScreenshotSettings {
    const changes = validateSettings(patch);
    const next = { ...this.read(), ...changes };
    if (!Object.keys(changes).length) return next;
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
    return next;
  }
}

export function historyDirectory(settings: ScreenshotSettingsStore): string {
  return join(dirname(settings.path), 'screenshots');
}
