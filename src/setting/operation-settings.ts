import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScreenshotSettingsStore } from './screenshot-settings.js';

export interface OperationSettings { minInterval: Record<string, number> }
export const defaultOperationSettings: OperationSettings = {
  minInterval: { device_control: 1, rotate: 1, tap: 0.4, double_tap: 0.9, long_press: 1.35, swipe: 0.9, scroll: 0.7, pinch: 0.8 },
};
const configurableTools = ['tap','double_tap','long_press','swipe','scroll','pinch','press_button','device_control','rotate','type_text','list_apps','open_url','install_app','launch_app','terminate_app','uninstall_app','describe_ui','get_logs','set_location','start_recording','stop_recording','recording_status'];
export const minIntervalSchema = { type: 'object', additionalProperties: false,
  description: 'Minimum start-to-start interval after each tool before the next non-image command, seconds (0–10). Partial updates merge. Images can run during this interval. Timed gestures also require their requested duration plus 0.2s. Omitted chain intervals choose a safe default; explicit insufficient intervals fail preflight.',
  properties: Object.fromEntries(configurableTools.map(name => [name, { type: 'number', minimum: 0, maximum: 10 }])),
};
export function validateMinInterval(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('minInterval must be an object mapping tool names to seconds.');
  for (const [tool, interval] of Object.entries(value)) {
    if (!configurableTools.includes(tool) || typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0 || interval > 10) throw new Error(`Invalid minInterval.${tool}: expected a supported non-image tool and seconds between 0 and 10.`);
  }
  return value as Record<string, number>;
}
export class OperationSettingsStore {
  constructor(readonly path: string) {}
  read(): OperationSettings {
    let saved: unknown;
    try { saved = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { minInterval: { ...defaultOperationSettings.minInterval } }; throw error; }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some(key => !['minInterval', 'minDelay'].includes(key))) throw new Error('Invalid operation settings.');
    const legacy = saved as { minDelay?: unknown; minInterval?: unknown };
    return { minInterval: { ...defaultOperationSettings.minInterval,
      ...(legacy.minDelay === undefined ? {} : validateMinInterval(legacy.minDelay)),
      ...(legacy.minInterval === undefined ? {} : validateMinInterval(legacy.minInterval)),
    } };
  }
  update(patch: unknown): OperationSettings {
    const changes = validateMinInterval(patch);
    const next = { minInterval: { ...this.read().minInterval, ...changes } };
    if (!Object.keys(changes).length) return next;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const pending = `${this.path}.${randomUUID()}.tmp`;
    try { writeFileSync(pending, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(pending, this.path); }
    finally { rmSync(pending, { force: true }); }
    return next;
  }
}
export function operationSettingsStore(settings: ScreenshotSettingsStore) { return new OperationSettingsStore(join(dirname(settings.path), 'operations.json')); }
export function readOperationSettings(settings: ScreenshotSettingsStore): OperationSettings {
  return typeof settings?.path === 'string' ? operationSettingsStore(settings).read() : { minInterval: { ...defaultOperationSettings.minInterval } };
}
