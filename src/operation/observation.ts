import { prepareTextInput, awaitTextInput, releaseTextInput } from './text-input.js';
import { presentElements, resolveElementDetail, elementDetailSchema, publicEvent } from '../mcp/element-presentation.js';
import { saveTimelineCapture, readTimelineCapture, deleteTimelineCapture, type StoredCapture } from '../storage/timeline-images.js';
import { ObservationStore } from '../storage/observation-store.js';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTimeline, timelinePattern, withEventIndexes, type TimelineId } from '../common/operation.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { IDBClient } from './idb-client.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import type { ScreenshotSettingsStore } from '../setting/screenshot-settings.js';
import { captureTools } from './capture.js';
import { parseObservationSnapshot, translateTouches, translateEditing, observationEvents, type ObservationSnapshot, type ObservationEvent } from './observation-events.js';

const exec = promisify(execFile);
const sessions = new WeakMap<IDBClient, Observation>();
const liveSessions = new Map<string, Observation>();
const schedulers = new WeakMap<IDBClient, (task: () => Promise<void>) => Promise<void>>();
export function setObservationScheduler(client: IDBClient, schedule: (task: () => Promise<void>) => Promise<void>) { schedulers.set(client, schedule); }
export async function stopClientObservation(client: IDBClient, bundleId?: string) {
  const session = sessions.get(client);
  if (bundleId && session?.bundleId !== bundleId) return;
  return session?.stop();
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function simctl(args: string[], env?: NodeJS.ProcessEnv) {
  return exec('xcrun', ['simctl', ...args], { env, timeout: 15000, maxBuffer: 1024 * 1024 });
}
interface Frame { type: 'capture'; captureIndex: number; startedAt: number; endedAt: number; error?: string }
class Observation {
  readonly timeline: TimelineId;
  readonly directory: string;
  active = false;
  private source = '';
  private timer?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private captures: Frame[] = [];
  private nextCapture = 0;
  private captureData = new Map<number, StoredCapture>();
  private readonly store: ObservationStore;
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
  private stopping?: Promise<ReturnType<Observation['status']>>;
  constructor(readonly client: IDBClient, readonly settings: ScreenshotSettingsStore, readonly bundleId: string,
    readonly maxDuration: number, readonly interval: number) {
    const root = join(dirname(settings.path), 'observations');
    this.store = new ObservationStore(root);
    do { this.timeline = createTimeline('session'); } while (this.store.find(this.timeline));
    this.directory = root;
  }
  private save() {
    const signature = `${this.raw.length}:${this.captures.map(c => c.captureIndex).join(',')}:${this.active}:${this.failure}`;
    if (signature === this.savedSignature) return;
    this.store.save({ timeline: this.timeline,
      udid: this.client.getConnectedDevice(), bundleId: this.bundleId, startedAt: this.startedAt, expireAt: this.expireAt,
      captureInterval: this.interval, handshake: this.snapshot?.handshake,
      events: observationEvents([...translateTouches(this.snapshot?.samples ?? []), ...translateEditing(this.snapshot?.samples ?? [])], this.captures, this.timeline, this.startedAt).map(({ captureIndex, ...event }) => ({ ...event, ...(event.tool === 'capture' && captureIndex !== undefined && this.captureData.has(captureIndex) ? { capture: this.captureData.get(captureIndex)! } : {}) })), ...(this.failure ? { error: this.failure } : {}) }, this.active ? 'observing' : 'archived');
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
      const inputEnv = await prepareTextInput(this.client, this.bundleId);
      this.startedAt = Date.now();
      await simctl(['launch', udid, this.bundleId], { ...process.env,
        ...inputEnv, SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: resolve(library), SIMCTL_CHILD_ISIMBOT_OBSERVATION_TIMELINE: this.timeline });
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
      await awaitTextInput(this.client);
      this.active = true;
      liveSessions.set(this.timeline, this);
      this.save();
      this.timer = setInterval(() => this.tick(), 100);
      this.deadline = setTimeout(() => { void this.stop(); }, Math.max(0, this.expireAt - Date.now()));
      this.tick();
      return this.status();
    } catch (error) {
      releaseTextInput(this.client);
      this.failure = (error as Error).message;
      await this.stop();
      throw error;
    }
  }
  get expireAt() { return this.startedAt + this.maxDuration * 1000; }
  status() { return { success: !this.failure, timeline: this.timeline, deviceId: this.client.getConnectedDevice(),
    bundleId: this.bundleId, expireAt: this.expireAt, captureInterval: this.interval, active: this.active, captureCount: this.captures.length, directory: this.directory, observingPath: this.store.observingPath, observationsPath: this.store.observationsPath,
    ...(this.failure ? { error: this.failure, recoveryPath: this.source } : {}),
    scope: 'Experimental app-local touch recording. Restarts the app. Records standard UIKit/SwiftUI editing_begin/text_change/editing_end, including committed text and IME composing state. Password text is redacted. No system dialogs or other apps. Native input remains enabled after stop. Includes both human and automation-generated touches; cannot distinguish their origin. Coordinates are device logical points.' }; }
  private tick() {
    if (!this.active) return;
    if (Date.now() >= this.expireAt) { void this.stop(); return; }
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
      const frame: Frame = { type: 'capture', captureIndex: this.nextCapture++, startedAt: Date.now(), endedAt: 0 };
      try {
        const png = join(tmpdir(), `isimbot-observation-${this.timeline}-${frame.captureIndex}.png`);
        const result = await captureTools[0].execute(this.client, { path: png, mode: 'logical', maxBytes: 2_000_000 }, this.settings) as CallToolResult;
        rmSync(png, { force: true });
        this.readEvents();
        if (!this.active) return;
        const size = result.content.reduce((sum, c) => sum + (c.type === 'image' ? Buffer.from(c.data, 'base64').length : 0), 0);
        if (this.bytes + size > 100 * 1024 * 1024 || this.captures.length >= 200) throw new Error('Observation capture limit reached (200 captures / 100 MB).');
        const stored = saveTimelineCapture(this.directory, this.timeline, frame.captureIndex, result);
        this.bytes += size;
        this.captureData.set(frame.captureIndex, stored);
      } catch (error) { frame.error = (error as Error).message; }
      finally { rmSync(join(tmpdir(), `isimbot-observation-${this.timeline}-${frame.captureIndex}.png`), { force: true }); }
      frame.endedAt = Date.now();
      if (!this.active) return;
      this.captures.push(frame);
      const discarded: StoredCapture[] = [];
      if (!this.sawTouch) while (this.captures.length > 2) {
        const old = this.captures.shift()!;
        const data = this.captureData.get(old.captureIndex);
        if (data) { this.bytes -= data.images.reduce((sum, image) => sum + image.sizeBytes, 0); discarded.push(data); }
        this.captureData.delete(old.captureIndex);
      }
      this.save();
      for (const data of discarded) deleteTimelineCapture(this.directory, data);
      if (frame.error?.includes('limit reached')) { this.failure = frame.error; await this.stop(); }
    };
    void (schedulers.get(this.client)?.(capture) ?? capture()).catch(error => {
      this.failure = (error as Error).message; void this.stop();
    }).finally(() => { this.pending = false; });
  }
  stop() {
    return this.stopping ??= this.finalize();
  }
  private async finalize() {
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
    liveSessions.delete(this.timeline);
    return this.status();
  }
}

async function stopExpiredObservations(settings: ScreenshotSettingsStore) {
  const store = new ObservationStore(join(dirname(settings.path), 'observations'));
  for (const saved of store.expired()) {
    const live = liveSessions.get(saved.timeline);
    if (live && live.settings.path === settings.path) {
      await live.stop();
      if (store.lookup(saved.timeline)?.observing) throw new Error(`Could not archive expired observation ${saved.timeline}.`);
      continue;
    }
    // Recover expired sessions after an MCP restart without restarting the app.
    let final = saved;
    try {
      if (!saved.udid || !/^[A-Za-z0-9-]+$/.test(saved.udid) || !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(saved.bundleId)) throw new Error('Invalid saved device/app identifier.');
      const { stdout } = await simctl(['get_app_container', saved.udid, saved.bundleId, 'data']);
      const container = stdout.trim();
      if (!container.startsWith('/')) throw new Error('Invalid app data container.');
      const source = join(container, 'tmp', `isimbot-observation-${saved.timeline}`);
      rmSync(join(source, 'active'), { force: true });
      await sleep(150);
      const path = join(source, 'samples.json');
      if (existsSync(path)) {
        if (statSync(path).size > 16 * 1024 * 1024) throw new Error('Observation event limit reached (16 MB).');
        const snapshot = parseObservationSnapshot(readFileSync(path, 'utf8'), saved.timeline);
        const gestures = observationEvents([...translateTouches(snapshot.samples), ...translateEditing(snapshot.samples)], [], saved.timeline as TimelineId, saved.startedAt);
        const events = [...saved.events.filter(e => e.tool === 'capture'), ...gestures].sort((a, b) => a.time - b.time);
        final = { ...saved, handshake: snapshot.handshake, events: events.map((e, i) => ({ ...e, delay: e.time - (events[i - 1]?.time ?? 0) })) };
      }
    } catch (error) {
      final = { ...saved, error: [saved.error, `Expired session archived from saved data; final native collection unavailable: ${(error as Error).message}. The recording lease expires without refresh.`].filter(Boolean).join(' ') };
    }
    store.save(final, 'archived');
  }
}
const timelineProperty = { type: 'string', description: 'session_xxxxxxxx timeline returned by start_observation. Stored sessions survive MCP restarts.' };
export const observationTools: ToolDefinition[] = [
  { definition: { name: 'start_observation', description: 'EXPERIMENTAL: always create a new session (ended sessions cannot resume) and restart an installed simulator app with an in-process touch recorder. No host input monitoring. Records app-local touches and background logical capture at per-session captureInterval (default 0.5 seconds); reads may take longer. Before first touch/editing event retain only latest 2 captures. Stops at maxDuration/200 captures/100MB. Records app-local editing notifications (editing_begin/text_change/editing_end, text and composing state; password values redacted), not raw keyboard keys. Enables native Agent text input. No system dialogs or other apps. Native framework must be built. App compatibility is not guaranteed.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      bundleId: { type: 'string' }, maxDuration: { type: 'number', minimum: 1, maximum: 1800, default: 300 },
      captureInterval: { type: 'number', minimum: 0.5, maximum: 10, default: 0.5 },
    }, required: ['bundleId'] } },
    async execute(client, args, settings) {
      await stopExpiredObservations(settings);
      if (sessions.get(client)?.active) throw new Error('An observation is already active on this device. Stop it first.');
      const session = new Observation(client, settings, args.bundleId as string, args.maxDuration as number ?? 300, args.captureInterval as number ?? 0.5);
      sessions.set(client, session); return session.start();
    } },
  { definition: { name: 'stop_observation', description: 'Stop the active app observation on this device. Leaves app running; observation hooks become inactive; native Agent text input remains enabled until ordinary app relaunch or MCP shutdown. Records remain on disk. Does not unload the framework; ordinary app relaunch removes it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    async execute(client) { return await stopClientObservation(client) ?? { success: true, active: false }; } },
  { definition: { name: 'get_observation', description: 'Read a saved observation, automatically stopping and archiving it first if still running: paginated timeline and raw touch paths. Records describe observed actions, not executable replay instructions. Every event has a zero-based index across all tools; timeline is returned only at the top level. Indexes are stable after archiving; pagination preserves these indexes. time is elapsed seconds, not an identifier. Capture elementDetail defaults to changes against the immediately previous capture in this session, including across pages. number returns a count; list returns compact elements; changes returns appeared/moved/disappeared/updated changeTypes. First capture marks all elements appeared; missing snapshots return elements:null with an error. Anonymous or duplicate-ID elements can match by unique content and size; ambiguous matches remain removal/addition. A returned empty changes list does not mean pixels are unchanged. Includes at most 2 capture images when includeImages=true. Unsupported/multitouch gestures remain explicitly marked. No candidate operation_chain is generated. Historical screenshot IDs are not valid coordinate references; use logical points.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { timeline: timelineProperty,
      offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
      includeImages: { type: 'boolean', default: false },
      elementDetail: { ...elementDetailSchema, description: 'Element presentation for capture events only. changes compares full consecutive saved snapshots, independent of pagination or prior get calls; disappeared entries use their previous text/frame.' } }, required: ['timeline'] } }, responseType: 'mcp',
    async execute(client, args, settings): Promise<CallToolResult> {
      const id = args.timeline as string;
      if (!timelinePattern.test(id) || !id.startsWith('session_')) throw new Error('Invalid timeline.');
      await stopExpiredObservations(settings);
      const store = new ObservationStore(join(dirname(settings.path), 'observations'));
      let saved = store.lookup(id);
      if (!saved) throw new Error('Observation timeline was not found.');
      if (saved.session.udid !== client.getConnectedDevice()) throw new Error('Observation belongs to a different device. Supply its deviceId.');
      if (saved.observing) {
        const session = sessions.get(client);
        if (!session || session.timeline !== id) throw new Error('Observation is owned by another or interrupted MCP process. Stop it in the owning process before retrieving it.');
        await session.stop();
        saved = store.lookup(id);
        if (!saved || saved.observing) throw new Error('Observation could not be archived. Retry get_observation after resolving the storage error.');
      }
      const metadata = saved.session;
      if (metadata.timeline !== id || !Array.isArray(metadata.events) || metadata.events.some((e: {timeline: string}) => e.timeline !== id)) throw new Error('Saved observation timeline mismatch.');
      const recordedEvents = withEventIndexes(metadata.events);
      const offset = args.offset as number ?? 0, limit = args.limit as number ?? 100;
      const page = recordedEvents.slice(offset, offset + limit);
      const content: CallToolResult['content'] = [];
      let images = 0;
      const elementDetail = resolveElementDetail(args.elementDetail);
      let previousCapture: (typeof recordedEvents)[number] | undefined;
      for (let i = Math.min(offset, recordedEvents.length) - 1; i >= 0; i--) {
        if (recordedEvents[i].tool === 'capture') { previousCapture = recordedEvents[i]; break; }
      }
      const events = page.map(entry => {
        if (entry.tool !== 'capture') return entry.points
          ? { ...publicEvent(entry), pointCount: entry.points.length, points: entry.points.length > 200 ? [...entry.points.slice(0, 199), entry.points.at(-1)] : entry.points, pointsTruncated: entry.points.length > 200 }
          : publicEvent(entry);
        const previous = previousCapture;
        previousCapture = entry;
        const { capture, ...event } = publicEvent(entry);
        const presentation = presentElements(capture?.metadata, previous?.capture?.metadata, elementDetail, previous !== undefined);
        const comparison = elementDetail === 'changes' ? { comparedToIndex: previous?.index ?? null } : {};
        const projected = { ...event, ...comparison, ...presentation, images: capture?.images ?? [],
          ...(event.error ? { error: [event.error, presentation.error].filter(Boolean).join(' ') } : {}) };
        if (capture && args.includeImages && images < 2) {
          try {
            content.push({ type: 'text', text: `Event index ${entry.index}: capture; time ${entry.time}` }, ...readTimelineCapture(store.directory, capture, id));
            images++;
          } catch (error) { return { ...projected, error: [projected.error, `Capture image unavailable: ${(error as Error).message}`].filter(Boolean).join(' ') }; }
        }
        return projected;
      });
      const summary = { success: true, timeline: id, elementDetail, bundleId: metadata.bundleId, captureInterval: metadata.captureInterval, expireAt: metadata.expireAt, handshake: metadata.handshake, udid: metadata.udid,
        active: sessions.get(client)?.timeline === id && sessions.get(client)!.active,
        interrupted: saved.observing && sessions.get(client)?.timeline !== id,
        error: metadata.error, totalEvents: recordedEvents.length, offset, nextOffset: offset + page.length < recordedEvents.length ? offset + page.length : null,
        events };
      return { content: [{ type: 'text', text: JSON.stringify(summary) }, ...content], structuredContent: summary };
    } },
];
