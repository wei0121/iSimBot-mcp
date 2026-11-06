import { withDirectoryLock } from './directory-lock.js';
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { timelinePattern, withEventIndexes } from '../common/operation.js';
import type { ObservationEvent } from '../operation/observation-events.js';
import type { StoredCapture } from './timeline-images.js';

export interface StoredEvent extends ObservationEvent { capture?: StoredCapture }
export interface ObservationSession {
  timeline: string; udid: string | null; bundleId: string; startedAt: number; expireAt: number;
  captureInterval: number; handshake?: unknown; error?: string;
  events: StoredEvent[];
}
export class ObservationStore {
  readonly observingPath: string;
  readonly observationsPath: string;
  constructor(readonly directory: string) {
    this.observingPath = join(directory, 'observing.json');
    this.observationsPath = join(directory, 'observations.json');
  }
  private read(path: string): ObservationSession[] {
    try {
      if (!lstatSync(path).isFile()) throw new Error('Observation storage must be a regular JSON file.');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(value)) for (const session of value) if (session && Array.isArray(session.events)) {
        if (session.handshake && Number.isFinite(session.handshake.time)) { session.handshake = { ...session.handshake, timestamp: Math.round(session.handshake.time) }; delete session.handshake.time; }
        session.events = session.events.map((event: any) => {
          if (!event) return event;
          const { time, ...rest } = event;
          return { ...rest, timestamp: event.timestamp ?? (Number.isFinite(time) && Number.isFinite(session.startedAt) ? Math.round(session.startedAt + time * 1000) : undefined),
            ...(Array.isArray(event.points) ? { points: event.points.map(({ time, ...point }: any) => ({ ...point, timestamp: point.timestamp ?? time })) } : {}) };
        });
      }
      if (!Array.isArray(value) || value.some(s => !s || !timelinePattern.test(s.timeline) || !Array.isArray(s.events) || s.events.some((e: StoredEvent) => !e || e.timeline !== s.timeline || !Number.isFinite(e.timestamp)))) throw new Error('Invalid observation array.');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private write(path: string, records: ObservationSession[]) {
    const pending = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(pending, JSON.stringify(records), { flag: 'wx', mode: 0o600 });
      renameSync(pending, path);
    } finally { rmSync(pending, { force: true }); }
  }
  private locked<T>(action: () => T): T { return withDirectoryLock(this.directory, action); }
  expired(now = Date.now()): ObservationSession[] {
    return this.locked(() => this.read(this.observingPath).filter(s => Number.isFinite(s.expireAt) && s.expireAt <= now));
  }
  find(timeline: string): ObservationSession | undefined {
    return this.lookup(timeline)?.session;
  }
  lookup(timeline: string): { session: ObservationSession; observing: boolean } | undefined {
    return this.locked(() => {
      const archived = this.read(this.observationsPath).find(s => s.timeline === timeline);
      if (archived) return { session: archived, observing: false };
      const current = this.read(this.observingPath).find(s => s.timeline === timeline);
      return current ? { session: current, observing: true } : undefined;
    });
  }
  save(session: ObservationSession, state: 'observing' | 'archived') {
    if (!timelinePattern.test(session.timeline) || session.events.some(e => e.timeline !== session.timeline || !Number.isFinite(e.timestamp))) throw new Error('Invalid observation timeline/events.');
    this.locked(() => {
      const current = this.read(this.observingPath);
      const history = this.read(this.observationsPath);
      const existing = [...history, ...current].find(s => s.timeline === session.timeline);
      if (existing && existing.startedAt !== session.startedAt) throw new Error('Observation timeline collision.');
      // Ended sessions are immutable and cannot be resumed or overwritten.
      if (history.some(s => s.timeline === session.timeline)) {
        if (current.some(s => s.timeline === session.timeline)) this.write(this.observingPath, current.filter(s => s.timeline !== session.timeline));
        return;
      }
      const value = { ...session, events: withEventIndexes([...session.events].sort((a, b) => a.timestamp - b.timestamp)) };
      if (state === 'observing') {
        if (!existsSync(this.observationsPath)) this.write(this.observationsPath, history);
        this.write(this.observingPath, [...current.filter(s => s.timeline !== session.timeline), value]);
      } else {
        // Archive first: interruption between these writes cannot lose the session.
        this.write(this.observationsPath, [...history.filter(s => s.timeline !== session.timeline), value]);
        this.write(this.observingPath, current.filter(s => s.timeline !== session.timeline));
      }
    });
  }
}
