import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScreenshotSettingsStore } from '../setting/screenshot-settings.js';
import { ToolError } from '../mcp/tool-error.js';

export const uiSnapshotName = /^ui-\d{13}-[0-9a-f-]{36}\.json$/;
export function uiDirectory(settings: ScreenshotSettingsStore) { return join(dirname(settings.path), 'ui'); }
export function uiSnapshot(settings: ScreenshotSettingsStore, raw?: string, snapshotId?: string) {
  const directory = uiDirectory(settings);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error('UI snapshot storage must be a regular directory.');
  if (snapshotId !== undefined && !uiSnapshotName.test(snapshotId)) throw new ToolError('Invalid snapshotId. Use the ID returned by describe_ui.', { code: 'INVALID_UI_SNAPSHOT' });
  const id = snapshotId ?? `ui-${Date.now()}-${randomUUID()}.json`, path = join(directory, id);
  let tree: unknown;
  if (raw !== undefined) {
    tree = JSON.parse(raw);
    if (!Array.isArray(tree) && (!tree || typeof tree !== 'object')) throw new Error('Invalid accessibility tree.');
    const pending = join(directory, `.pending-${randomUUID()}`);
    try { writeFileSync(pending, JSON.stringify(tree), { mode: 0o600, flag: 'wx' }); renameSync(pending, path); }
    finally { rmSync(pending, { force: true }); }
    const files = readdirSync(directory, { withFileTypes: true }).filter(e => e.isFile() && uiSnapshotName.test(e.name)).map(e => e.name).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 200))) rmSync(join(directory, old), { force: true });
  } else {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Invalid snapshot file.');
      tree = JSON.parse(readFileSync(path, 'utf8'));
    } catch { throw new ToolError('UI snapshot is missing, cleaned or unreadable. Call describe_ui without snapshotId to take a new snapshot.', { code: 'UI_SNAPSHOT_UNAVAILABLE', snapshotId: id }); }
  }
  return { snapshotId: id, path, tree };
}
