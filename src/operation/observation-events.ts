import { defaultOperationSettings, type OperationSettings } from '../setting/operation-settings.js';
import { createParentId, parentIdPattern, prepareSteps, withRelativeTiming, type OperationRecord, type ParentId } from '../common/operation.js';
import { gesturesTools } from './gestures.js';
import { captureTools } from './capture.js';
import { screenshotTools } from './screenshot.js';
export interface TouchPoint { id: string; phase: number; x: number; y: number; touchTime: number; tapCount: number; scrollViews?: Array<{id: string; panState: number; offsetX: number; offsetY: number}> }
export interface TouchEvent { type: 'touch'; time: number; touches: TouchPoint[] }
export interface RecordedGesture {
  type: 'operation' | 'unsupported'; startedAt: number; endedAt: number;
  tool?: string; arguments?: Record<string, number | string>; reason?: string;
  points: Array<{ x: number; y: number; time: number }>;
}
// Keep raw points: a straight swipe is an approximation of a possibly curved path.
export function translateTouches(events: TouchEvent[]): RecordedGesture[] {
  const active = new Map<string, { start: number; points: RecordedGesture['points']; multi: boolean; scrolling: boolean }>();
  const result: RecordedGesture[] = [];
  for (const event of events) {
    for (const t of event.touches) if (t.phase === 0) active.set(t.id, { start: event.time, points: [], multi: false, scrolling: false });
    if (active.size > 1) for (const state of active.values()) state.multi = true;
    for (const t of event.touches) {
      const state = active.get(t.id);
      if (!state) continue;
      state.scrolling ||= t.scrollViews?.some(view => [1, 2, 3].includes(view.panState)) ?? false;
      state.points.push({ x: t.x, y: t.y, time: event.time });
      if (t.phase !== 3 && t.phase !== 4) continue;
      active.delete(t.id);
      const first = state.points[0], last = state.points.at(-1)!;
      const duration = Math.max(0, (event.time - state.start) / 1000);
      const base = { startedAt: state.start, endedAt: event.time, points: state.points };
      if (state.multi || t.phase === 4) {
        result.push({ ...base, type: 'unsupported', reason: state.multi ? 'Multi-touch: raw points retained; no single-finger replay generated.' : 'Touch cancelled.' });
      } else if (state.points.some(p => Math.hypot(p.x - first.x, p.y - first.y) > 8)) {
        if (state.scrolling) {
          const dx = last.x - first.x, dy = last.y - first.y;
          const horizontal = Math.abs(dx) > Math.abs(dy);
          result.push({ ...base, type: 'operation', tool: 'scroll', arguments: {
            x1: first.x, y1: first.y, direction: horizontal ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'),
            distance: Math.abs(horizontal ? dx : dy),
          } });
        } else result.push({ ...base, type: 'operation', tool: 'swipe', arguments: { x1: first.x, y1: first.y, x2: last.x, y2: last.y, duration } });
      } else if (duration >= 0.5) {
        result.push({ ...base, type: 'operation', tool: 'long_press', arguments: { x: first.x, y: first.y, duration } });
      } else {
        const previous = result.at(-1);
        // UIKit's count distinguishes a double tap from two merely close taps.
        if (t.tapCount === 2 && previous?.tool === 'tap' && previous.endedAt <= state.start &&
          state.start - previous.endedAt <= 500 && Math.hypot(previous.points[0].x - first.x, previous.points[0].y - first.y) <= 20) {
          result[result.length - 1] = { ...base, startedAt: previous.startedAt, points: [...previous.points, ...state.points],
            type: 'operation', tool: 'double_tap', arguments: previous.arguments };
        } else result.push({ ...base, type: 'operation', tool: 'tap', arguments: { x: first.x, y: first.y } });
      }
    }
  }
  for (const state of active.values()) result.push({ type: 'unsupported', startedAt: state.start,
    endedAt: state.points.at(-1)?.time ?? state.start, points: state.points, reason: 'Incomplete touch: no end received.' });
  return result.sort((a, b) => a.startedAt - b.startedAt);
}
export interface ObservationSnapshot {
  parentId: string;
  handshake: { type: 'ready'; parentId: string; protocol: number; bundleId: string; pid?: number };
  samples: TouchEvent[];
}
export function parseObservationSnapshot(text: string, parentId: string): ObservationSnapshot {
  const snapshot = JSON.parse(text);
  if (!parentIdPattern.test(parentId) || snapshot.parentId !== parentId || !Array.isArray(snapshot.samples)) throw new Error('Observation parentId mismatch or invalid samples.');
  const handshake = snapshot.handshake;
  if (!handshake || handshake.type !== 'ready' || handshake.parentId !== parentId || handshake.protocol !== 3) throw new Error('Invalid observation handshake/parentId.');
  for (const e of snapshot.samples) {
    if (e.parentId !== parentId) throw new Error('Observation event parentId mismatch.');
    if (e.type === 'limit') throw new Error('Native touch event limit reached (100000 events).');
    if (e.type !== 'touch' || !Number.isFinite(e.time) || !Array.isArray(e.touches) || e.touches.length > 20 ||
      !e.touches.every((t: TouchPoint) => typeof t.id === 'string' && [0, 1, 2, 3, 4].includes(t.phase) &&
        [t.x, t.y, t.touchTime].every(Number.isFinite) && Number.isInteger(t.tapCount) && t.tapCount >= 0 &&
        (t.scrollViews === undefined || Array.isArray(t.scrollViews) && t.scrollViews.every(view => typeof view.id === 'string' && Number.isInteger(view.panState) && view.panState >= 0 && view.panState <= 5 && [view.offsetX, view.offsetY].every(Number.isFinite))))) throw new Error('Invalid observation event data');
  }
  return snapshot;
}
export interface ObservationEvent extends OperationRecord {
  points?: RecordedGesture['points'];
  reason?: string;
  index?: number;
  error?: string;
}
export function observationEvents(gestures: RecordedGesture[], captures: Array<{type: 'capture'; index: number; startedAt: number; endedAt: number; error?: string}>, parentId: ParentId, startedAt: number): ObservationEvent[] {
  const entries = [
    ...gestures.map(({ type, tool, arguments: args, ...gesture }) => ({ ...gesture, tool: type === 'operation' ? tool! : 'unsupported', arguments: args ?? {} })),
    ...captures.map(({ type, ...frame }) => ({ ...frame, tool: 'capture', arguments: {} })),
  ];
  return withRelativeTiming(entries, parentId, startedAt);
}
export function operationChain(source: RecordedGesture[] | OperationRecord[], origin?: number, timing: OperationSettings = defaultOperationSettings) {
  const parentId = createParentId('chain');
  const records: OperationRecord[] = source.length && 'startedAt' in source[0]
    ? observationEvents(source as RecordedGesture[], [], createParentId('session'), origin ?? (source[0] as RecordedGesture).startedAt)
    : source as OperationRecord[];
  let previousStart = 0;
  const steps = records.filter(record => record.tool !== 'unsupported').map(record => {
    const delay = record.time - previousStart;
    previousStart = record.time;
    return { parentId, tool: record.tool, arguments: record.arguments, delay, time: record.time, duration: record.duration };
  });
  let error: string | undefined;
  try {
    if (source.length !== steps.length) throw new Error('Unsupported observations cannot be replayed.');
    prepareSteps(steps, [...gesturesTools, ...captureTools, ...screenshotTools], parentId, timing);
  } catch (failure) { error = (failure as Error).message; }
  return { parentId, steps, replayable: !error, ...(error ? { error } : {}),
    note: 'Candidate replay only. delay is start-to-start, duration never adds to delay. Backend timing and trajectories may differ. Unsupported operations or limits require adaptation; overlapping non-image commands fail at execution.' };
}
