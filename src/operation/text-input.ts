import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IDBClient } from './idb-client.js';
import { ToolError } from '../mcp/tool-error.js';

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
interface Bridge { sessionId: string; bundleId: string; directory: string; pid?: number; heartbeat?: NodeJS.Timeout; busy: boolean }
const bridges = new WeakMap<IDBClient, Bridge>();
export const nativeLibrary = () => fileURLToPath(new URL('../native/isimbot-observer.dylib', import.meta.url));
function atomic(path: string, data: unknown) {
  const pending = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(pending, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); renameSync(pending, path); }
  finally { rmSync(pending, { force: true }); }
}
function read(path: string) {
  if (statSync(path).size > 2 * 1024 * 1024) throw new Error('Native text response exceeds 2 MB.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function releaseTextInput(client: IDBClient, bundleId?: string) {
  const bridge = bridges.get(client);
  if (!bridge || bundleId && bridge.bundleId !== bundleId) return;
  bridges.delete(client); clearInterval(bridge.heartbeat);
  rmSync(bridge.directory, { recursive: true, force: true });
}
// Preparation does not launch/restart an app. The caller owns that explicit lifecycle change.
export async function prepareTextInput(client: IDBClient, bundleId: string) {
  const udid = client.getConnectedDevice();
  if (!udid) throw new Error('Supply deviceId.');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId)) throw new Error('Invalid bundleId.');
  if (!existsSync(nativeLibrary())) throw new Error('Native framework missing. Run ./scripts/local-npm run build:observation.');
  const { stdout } = await exec('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'data'], { timeout: 15000 });
  const container = stdout.trim();
  if (!container.startsWith('/')) throw new Error('Invalid app data container.');
  releaseTextInput(client);
  const sessionId = randomUUID();
  const directory = join(container, 'tmp', `isimbot-input-${sessionId}`);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  writeFileSync(join(directory, 'active'), '', { flag: 'wx', mode: 0o600 });
  const bridge: Bridge = { sessionId, bundleId, directory, busy: false };
  bridges.set(client, bridge);
  bridge.heartbeat = setInterval(() => {
    try { utimesSync(join(directory, 'active'), new Date(), new Date()); }
    catch { releaseTextInput(client); }
  }, 3000).unref();
  return { SIMCTL_CHILD_ISIMBOT_TEXT_INPUT_SESSION: sessionId, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: nativeLibrary() };
}
export async function awaitTextInput(client: IDBClient) {
  const bridge = bridges.get(client);
  if (!bridge) throw new Error('Text input bridge not prepared.');
  const ready = join(bridge.directory, 'ready.json');
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    if (existsSync(ready)) {
      const value = read(ready);
      if (value.sessionId !== bridge.sessionId || value.bundleId !== bridge.bundleId || value.protocol !== 1 || (!Number.isSafeInteger(value.pid) || value.pid <= 0)) throw new Error('Invalid native text input handshake.');
      bridge.pid = value.pid;
      return;
    }
    await sleep(50);
  }
  throw new ToolError('App did not acknowledge enhanced text input. It may reject injection or have crashed. Relaunch explicitly with enableTextInput:true before retrying.', { code: 'TEXT_INPUT_NOT_READY' });
}
export async function launchWithTextInput(client: IDBClient, bundleId: string) {
  const env = await prepareTextInput(client, bundleId);
  try {
    const udid = client.getConnectedDevice()!;
    await exec('xcrun', ['simctl', 'terminate', udid, bundleId], { timeout: 10000 }).catch(() => {});
    await exec('xcrun', ['simctl', 'launch', udid, bundleId], { env: { ...process.env, ...env }, timeout: 15000 });
    await awaitTextInput(client);
    return { success: true, bundleId, restarted: true, textInput: 'native' };
  } catch (error) { releaseTextInput(client); throw error; }
}
export async function typeIntoFocusedField(client: IDBClient, text: string, mode: 'insert' | 'replace' = 'insert') {
  if (typeof text !== 'string' || !['insert', 'replace'].includes(mode)) throw new Error('Expected text and mode insert or replace.');
  if (Buffer.byteLength(text) > 128 * 1024) throw new ToolError('Text exceeds the 128 KiB input limit.', { code: 'TEXT_TOO_LARGE' });
  const bridge = bridges.get(client);
  if (!bridge) {
    if (mode !== 'insert' || /[^\x20-\x7e\r\n\t]/.test(text)) throw new ToolError('Unicode, replace and clear require enhanced input. Explicitly launch_app with enableTextInput:true (restarts app), or start_observation, then focus a standard text field and retry. No input was sent.', { code: 'ENHANCED_INPUT_REQUIRED' });
    await client.typeText(text);
    return { success: true, mode, transport: 'idb', message: 'ASCII keyboard input sent; use capture to verify the field.' };
  }
  if (bridge.busy) throw new ToolError('Another text request is in progress on this device.', { code: 'TEXT_INPUT_BUSY' });
  if (!bridge.pid) throw new ToolError('Enhanced text input is not ready.', { code: 'TEXT_INPUT_NOT_READY' });
  try { process.kill(bridge.pid, 0); } catch { releaseTextInput(client); throw new ToolError('Enhanced app exited. Explicitly relaunch with enableTextInput:true.', { code: 'TEXT_INPUT_APP_EXITED' }); }
  bridge.busy = true;
  const requestId = randomUUID(), expiresAt = Date.now() + 4000;
  try {
    atomic(join(bridge.directory, 'command.json'), { sessionId: bridge.sessionId, requestId, expiresAt, text, mode });
    while (Date.now() < expiresAt + 500) {
      const response = join(bridge.directory, 'response.json');
      if (existsSync(response)) {
        const value = read(response);
        if (value.sessionId === bridge.sessionId && value.requestId === requestId) {
          if (!value.success) throw new ToolError(value.error ?? 'Native input failed.', { code: value.code ?? 'TEXT_INPUT_FAILED', requestId, ...(value.details ? { details: value.details } : {}) });
          const { sessionId: _session, ...result } = value;
          return { ...result, mode, transport: 'native', bundleId: bridge.bundleId };
        }
      }
      await sleep(25);
    }
    atomic(join(bridge.directory, 'cancel.json'), { sessionId: bridge.sessionId, requestId });
    throw new ToolError('Native input timed out; it may already have applied. Inspect the field before retrying. The request will not be retried automatically.', { code: 'TEXT_INPUT_TIMEOUT', requestId });
  } finally { bridge.busy = false; rmSync(join(bridge.directory, 'command.json'), { force: true }); }
}
