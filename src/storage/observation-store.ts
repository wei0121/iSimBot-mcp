import { existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { timelinePattern } from '../common/operation.js';
import type { ObservationEvent } from '../operation/observation-events.js';
import type { StoredCapture } from './observation-images.js';

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
      if (!Array.isArray(value) || value.some(s => !s || !timelinePattern.test(s.timeline) || !Array.isArray(s.events) || s.events.some((e: StoredEvent) => !e || e.timeline !== s.timeline || !Number.isFinite(e.time)))) throw new Error('Invalid observation array.');
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
  private locked<T>(action: () => T): T {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.directory).isDirectory()) throw new Error('Observation directory must not be a symbolic link.');
    const lock = join(this.directory, '.lock');
    const deadline = Date.now() + 5000;
    while (true) {
      try { mkdirSync(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try { if (!lstatSync(lock).isDirectory()) throw new Error('Invalid observation lock.'); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') continue; throw failure; }
        if (Date.now() >= deadline) throw new Error('Observation storage is busy or has an abandoned .lock directory. Retry; if its owner process has exited, remove that lock before retrying.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); return action(); }
    finally { rmSync(lock, { recursive: true, force: true }); }
  }
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
    if (!timelinePattern.test(session.timeline) || session.events.some(e => e.timeline !== session.timeline || !Number.isFinite(e.time))) throw new Error('Invalid observation timeline/events.');
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
      const value = { ...session, events: [...session.events].sort((a, b) => a.time - b.time) };
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
