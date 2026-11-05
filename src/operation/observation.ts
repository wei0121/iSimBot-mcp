import { readOperationSettings } from '../setting/operation-settings.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTimeline, timelinePattern, type TimelineId } from '../common/operation.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IDBClient } from './idb-client.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import type { ScreenshotSettingsStore } from '../setting/screenshot-settings.js';
import { captureTools } from './capture.js';
import { operationChain, parseObservationSnapshot, translateTouches, observationEvents, type ObservationSnapshot, type ObservationEvent } from './observation-events.js';

const exec = promisify(execFile);
const sessions = new WeakMap<IDBClient, Observation>();
const schedulers = new WeakMap<IDBClient, (task: () => Promise<void>) => Promise<void>>();
export function setObservationScheduler(client: IDBClient, schedule: (task: () => Promise<void>) => Promise<void>) { schedulers.set(client, schedule); }
export async function stopClientObservation(client: IDBClient) { return sessions.get(client)?.stop(); }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function simctl(args: string[], env?: NodeJS.ProcessEnv) {
  return exec('xcrun', ['simctl', ...args], { env, timeout: 15000, maxBuffer: 1024 * 1024 });
}
interface Frame { type: 'capture'; index: number; startedAt: number; endedAt: number; error?: string }
class Observation {
  readonly timeline: TimelineId;
  readonly directory: string;
  active = false;
  private source = '';
  private timer?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private captures: Frame[] = [];
  private nextCapture = 0;
  private bytes = 0;
  private pending = false;
  private lastCapture = 0;
  private startedAt = Date.now();
  private sawTouch = false;
  private raw = '';
  private snapshot?: ObservationSnapshot;
  private savedSignature = '';
  private sourceSize = -1;
  private failure?: string;
  private pid?: number;
  constructor(readonly client: IDBClient, readonly settings: ScreenshotSettingsStore, readonly bundleId: string,
    readonly maxDuration: number, readonly interval: number) {
    const root = join(dirname(settings.path), 'observations');
    do { this.timeline = createTimeline('session'); } while (existsSync(join(root, this.timeline)));
    this.directory = join(root, this.timeline);
  }
  private save() {
    const signature = `${this.raw.length}:${this.captures.map(c => c.index).join(',')}:${this.active}:${this.failure}`;
    if (signature === this.savedSignature) return;
    writeFileSync(join(this.directory, 'session.json.tmp'), JSON.stringify({ timeline: this.timeline,
      udid: this.client.getConnectedDevice(), bundleId: this.bundleId, startedAt: this.startedAt,
      active: this.active, captureInterval: this.interval, handshake: this.snapshot?.handshake,
      events: observationEvents(translateTouches(this.snapshot?.samples ?? []), this.captures, this.timeline, this.startedAt), ...(this.failure ? { error: this.failure } : {}) }), { mode: 0o600 });
    renameSync(join(this.directory, 'session.json.tmp'), join(this.directory, 'session.json'));
    this.savedSignature = signature;
  }
  private readEvents() {
    const path = join(this.source, 'samples.json');
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size === this.sourceSize) return;
      if (size > 16 * 1024 * 1024) throw new Error('Observation event limit reached (16 MB).');
      const raw = readFileSync(path, 'utf8');
      const snapshot = parseObservationSnapshot(raw, this.timeline);
      this.raw = raw; this.snapshot = snapshot;
      this.sourceSize = size;
      this.sawTouch ||= snapshot.samples.length > 0;
    }
  }
  async start() {
    const udid = this.client.getConnectedDevice();
    if (!udid) throw new Error('Select a simulator with deviceId.');
    if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(this.bundleId)) throw new Error('Invalid bundleId.');
    const library = fileURLToPath(new URL('../native/isimbot-observer.dylib', import.meta.url));
    if (!existsSync(library)) throw new Error('Observation framework missing. Build locally with ./scripts/local-npm run build:observation (macOS/Xcode required).');
    const { stdout } = await simctl(['get_app_container', udid, this.bundleId, 'data']);
    const container = stdout.trim();
    if (!container.startsWith('/')) throw new Error('Invalid app data container.');
    this.source = join(container, 'tmp', `isimbot-observation-${this.timeline}`);
    mkdirSync(this.source, { recursive: true, mode: 0o700 });
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.source, 'active'), '', { mode: 0o600 });
    try {
      // App termination may legitimately fail if it is not running.
      await simctl(['terminate', udid, this.bundleId]).catch(() => {});
      this.startedAt = Date.now();
      await simctl(['launch', udid, this.bundleId], { ...process.env,
        SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: resolve(library), SIMCTL_CHILD_ISIMBOT_OBSERVATION_TIMELINE: this.timeline });
      const until = Date.now() + 8000;
      let ready = false;
      while (Date.now() < until) {
        this.readEvents();
        if (this.snapshot?.handshake.bundleId === this.bundleId) {
          this.pid = this.snapshot.handshake.pid; ready = true; break;
        }
        await sleep(100);
      }
      if (!ready) throw new Error('App did not acknowledge the observation framework. It may reject injection or have crashed; no recording is claimed.');
      this.active = true;
      this.save();
      this.timer = setInterval(() => this.tick(), 100);
      this.deadline = setTimeout(() => { void this.stop(); }, this.maxDuration * 1000);
      this.tick();
      return this.status();
    } catch (error) {
      this.failure = (error as Error).message;
      await this.stop();
      throw error;
    }
  }
  status() { return { success: !this.failure, timeline: this.timeline, deviceId: this.client.getConnectedDevice(),
    bundleId: this.bundleId, captureInterval: this.interval, active: this.active, captureCount: this.captures.length, directory: this.directory,
    ...(this.failure ? { error: this.failure, recoveryPath: this.source } : {}),
    scope: 'Experimental app-local touch recording. Restarts the app. No keyboard text, system dialogs or other apps. Includes both human and automation-generated touches; cannot distinguish their origin. Coordinates are device logical points.' }; }
  private tick() {
    if (!this.active) return;
    try {
      if (this.pid) {
        try { process.kill(this.pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') throw new Error('Observed app exited. Observation stopped; restart explicitly to record again.');
        }
      }
      utimesSync(join(this.source, 'active'), new Date(), new Date());
      this.readEvents(); this.save();
    } catch (error) { this.failure = (error as Error).message; void this.stop(); return; }
    if (this.pending || Date.now() - this.lastCapture < this.interval * 1000) return;
    this.pending = true;
    const capture = async () => {
      if (!this.active) return;
      if (this.captures.length >= 200) { this.failure = 'Observation capture limit reached (200 records).'; await this.stop(); return; }
      this.lastCapture = Date.now();
      const frame: Frame = { type: 'capture', index: this.nextCapture++, startedAt: Date.now(), endedAt: 0 };
      try {
        const png = join(this.directory, `${frame.index}.png`);
        const result = await captureTools[0].execute(this.client, { path: png, mode: 'logical', maxBytes: 2_000_000 }, this.settings) as CallToolResult;
        rmSync(png, { force: true });
        this.readEvents();
        if (!this.active) return;
        const serialized = JSON.stringify(result);
        this.bytes += Buffer.byteLength(serialized);
        if (this.bytes > 100 * 1024 * 1024 || this.captures.length >= 200) throw new Error('Observation capture limit reached (200 captures / 100 MB).');
        writeFileSync(join(this.directory, `${frame.index}.json`), serialized, { mode: 0o600 });
      } catch (error) { frame.error = (error as Error).message; }
      finally { rmSync(join(this.directory, `${frame.index}.png`), { force: true }); }
      frame.endedAt = Date.now();
      if (!this.active) return;
      this.captures.push(frame);
      if (!this.sawTouch) while (this.captures.length > 2) {
        const old = this.captures.shift()!;
        const file = join(this.directory, `${old.index}.json`);
        if (existsSync(file)) this.bytes -= statSync(file).size;
        rmSync(file, { force: true });
      }
      this.save();
      if (frame.error?.includes('limit reached')) { this.failure = frame.error; await this.stop(); }
    };
    void (schedulers.get(this.client)?.(capture) ?? capture()).catch(error => {
      this.failure = (error as Error).message; void this.stop();
    }).finally(() => { this.pending = false; });
  }
  async stop() {
    this.active = false; clearInterval(this.timer); clearTimeout(this.deadline);
    try { if (this.source) rmSync(join(this.source, 'active'), { force: true }); }
    catch (error) { this.failure ||= `Could not remove observation lease: ${(error as Error).message}. It expires after 10 seconds without refresh.`; }
    if (this.source) await sleep(150);
    try { if (this.source) this.readEvents(); } catch (error) { this.failure ||= (error as Error).message; }
    try { if (existsSync(this.directory)) this.save(); }
    catch (error) { this.failure ||= `Could not save observation: ${(error as Error).message}`; }
    // Only remove our own app-container staging directory once a durable copy exists.
    try { if (this.source && !this.failure) rmSync(this.source, { recursive: true, force: true }); }
    catch (error) { this.failure ||= `Staging cleanup failed: ${(error as Error).message}`; }
    return this.status();
  }
}
const timelineProperty = { type: 'string', description: 'session_xxxxxxxx timeline returned by start_observation. Stored sessions survive MCP restarts.' };
export const observationTools: ToolDefinition[] = [
  { definition: { name: 'start_observation', description: 'EXPERIMENTAL: restart an installed simulator app with an in-process touch recorder. No host input monitoring. Records app-local touches and background logical capture at per-session captureInterval (default 0.5 seconds); reads may take longer. Before first touch retain only latest 2 captures. Stops at maxDuration/200 captures/100MB. Does not record keyboard text, system dialogs or other apps. Native framework must be built. App compatibility is not guaranteed.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      bundleId: { type: 'string' }, maxDuration: { type: 'number', minimum: 1, maximum: 1800, default: 300 },
      captureInterval: { type: 'number', minimum: 0.5, maximum: 10, default: 0.5 },
    }, required: ['bundleId'] } },
    async execute(client, args, settings) {
      if (sessions.get(client)?.active) throw new Error('An observation is already active on this device. Stop it first.');
      const session = new Observation(client, settings, args.bundleId as string, args.maxDuration as number ?? 300, args.captureInterval as number ?? 0.5);
      sessions.set(client, session); return session.start();
    } },
  { definition: { name: 'stop_observation', description: 'Stop the active app observation on this device. Leaves app running; injected hooks become inactive. Records remain on disk. Does not unload the framework; ordinary app relaunch removes it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    async execute(client) { return await stopClientObservation(client) ?? { success: true, active: false }; } },
  { definition: { name: 'get_observation', description: 'Read a saved observation: paginated timeline, raw touch paths and candidate operation_chain. Includes at most 2 capture images when includeImages=true. Candidate replay is approximate; unsupported/multitouch gestures remain explicitly marked. Historical screenshot IDs are not valid coordinate references; use logical points.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { timeline: timelineProperty,
      offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      includeImages: { type: 'boolean', default: false } }, required: ['timeline'] } }, responseType: 'mcp',
    async execute(client, args, settings): Promise<CallToolResult> {
      const id = args.timeline as string;
      if (!timelinePattern.test(id) || !id.startsWith('session_')) throw new Error('Invalid timeline.');
      const dir = join(dirname(settings.path), 'observations', id);
      const metadata = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
      if (metadata.udid !== client.getConnectedDevice()) throw new Error('Observation belongs to a different device. Supply its deviceId.');
      if (metadata.timeline !== id || !Array.isArray(metadata.events) || metadata.events.some((e: {timeline: string}) => e.timeline !== id)) throw new Error('Saved observation timeline mismatch.');
      const recordedEvents = metadata.events as ReturnType<typeof observationEvents>;
      const offset = args.offset as number ?? 0, limit = args.limit as number ?? 10;
      const page = recordedEvents.slice(offset, offset + limit);
      const content: CallToolResult['content'] = [];
      let images = 0;
      const events = page.map(entry => {
        if (entry.points) return { ...entry, pointCount: entry.points.length, points: entry.points.length > 200 ? [...entry.points.slice(0, 199), entry.points.at(-1)] : entry.points, pointsTruncated: entry.points.length > 200 };
        if (entry.error) return entry;
        const capture = JSON.parse(readFileSync(join(dir, `${entry.index}.json`), 'utf8')) as CallToolResult;
        if (args.includeImages && images < 2) {
          content.push({ type: 'text', text: `Capture ${entry.index}; time ${entry.time}` }, ...capture.content.filter(c => c.type === 'image'));
          images++;
        }
        return { ...entry, metadata: capture.structuredContent };
      });
      const summary = { success: true, timeline: id, bundleId: metadata.bundleId, captureInterval: metadata.captureInterval, handshake: metadata.handshake, udid: metadata.udid,
        active: sessions.get(client)?.timeline === id && sessions.get(client)!.active,
        interrupted: metadata.active && sessions.get(client)?.timeline !== id,
        error: metadata.error, totalEntries: recordedEvents.length, offset, nextOffset: offset + page.length < recordedEvents.length ? offset + page.length : null,
        events, operationChain: { ...operationChain(page, undefined, readOperationSettings(settings)), scope: 'Steps in this page only; first delay equals the first step time relative to session start. Other delays are recomputed between retained starts.' } };
      return { content: [{ type: 'text', text: JSON.stringify(summary) }, ...content], structuredContent: summary };
    } },
];
