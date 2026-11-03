import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ScreenshotSettings {
  mode: 'logical' | 'pixel' | 'both';
  format: 'png' | 'jpeg';
  quality: number;
  maxBytes: number;
  maxSavedImages: number;
}
export const defaults: ScreenshotSettings = {
  mode: 'logical', format: 'png', quality: 80, maxBytes: 5_000_000, maxSavedImages: 200,
};
export const settingsSchema = {
  maxSavedImages: { type: 'integer', minimum: 1, maximum: 10000, description: 'Maximum automatically saved screenshots, default 200. Updating this value immediately deletes oldest managed screenshots over the limit. Explicit output paths are excluded.' },
  mode: { type: 'string', enum: ['logical', 'pixel', 'both'], default: 'logical', description: 'logical: one image pixel per touch point (default); pixel: native pixels; both: logical then pixel from one capture.' },
  format: { type: 'string', enum: ['png', 'jpeg'], description: 'PNG (default) preserves UI text without lossy compression. JPEG can save bandwidth.' },
  quality: { type: 'integer', minimum: 40, maximum: 100, description: 'JPEG quality only; ignored for PNG.' },
  maxBytes: { type: 'integer', minimum: 10_000, maximum: 5_000_000, default: 5_000_000, description: 'Default 5000000 (5 MB) per image. Maximum encoded image bytes BEFORE Base64 (~4/3 expansion). Returns an error if the requested dimensions cannot fit; never silently resizes.' },
};
export function validateSettings(value: unknown): Partial<ScreenshotSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Screenshot settings must be an object.');
  for (const [key, val] of Object.entries(value)) {
    if (key === 'mode') {
      if (!['logical', 'pixel', 'both'].includes(val as string)) throw new Error('mode must be logical, pixel or both');
    } else if (key === 'format') {
      if (val !== 'png' && val !== 'jpeg') throw new Error('format must be png or jpeg');
    } else {
      const bounds = { maxSavedImages: [1, 10000], quality: [40, 100], maxBytes: [10_000, 5_000_000] }[key];
      if (!bounds || typeof val !== 'number' || !Number.isInteger(val) || val < bounds[0] || val > bounds[1]) throw new Error(bounds ? `Invalid screenshot setting: ${key}=${JSON.stringify(val)}. Expected an integer between ${bounds[0]} and ${bounds[1]}${key === 'maxBytes' ? ' bytes (2 MB = 2000000)' : ''}. Retry with a value in this range; settings were not changed.` : `Unknown screenshot setting: ${key}. Allowed fields: mode, format, quality, maxBytes, maxSavedImages.`);
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
    const saved = JSON.parse(text);
    // Migrate legacy scale settings in memory; do not write on read.
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && 'scale' in saved) {
      delete saved.scale;
      if (saved.maxBytes === 2_000_000) delete saved.maxBytes;
    }
    return { ...defaults, ...validateSettings(saved) };
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
