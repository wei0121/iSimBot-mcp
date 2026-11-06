import { defaultOperationSettings, type OperationSettings } from '../setting/operation-settings.js';
import { createTimeline, timelinePattern, prepareSteps, withTimestampTiming, type OperationRecord, type TimelineId } from '../common/operation.js';
import { gesturesTools } from './gestures.js';
import { captureTools } from './capture.js';
import { screenshotTools } from './screenshot.js';
export interface TouchPoint { id: string; phase: number; x: number; y: number; touchTimestamp: number; tapCount: number; scrollViews?: Array<{id: string; panState: number; offsetX: number; offsetY: number}> }
export interface TouchEvent { type: 'touch'; timestamp: number; touches: TouchPoint[] }
export interface EditingEvent {
  type: 'editing_begin' | 'text_change' | 'editing_end'; timestamp: number;
  details: { target: { elementId: string | null; type: string; frame: { x: number; y: number; width: number; height: number } };
    text: string | null; textLength: number; redacted: boolean; composing: boolean; source: 'agent' | 'app_or_user'; requestId?: string };
}
export type NativeObservationEvent = TouchEvent | EditingEvent;
export interface RecordedEditing {
  type: 'operation'; tool: EditingEvent['type']; arguments: EditingEvent['details']; startedAt: number; endedAt: number;
}
export type RecordedAction = RecordedGesture | RecordedEditing;
export function translateEditing(events: NativeObservationEvent[]): RecordedEditing[] {
  return events.filter((event): event is EditingEvent => event.type !== 'touch').map(event => ({
    type: 'operation', tool: event.type, arguments: event.details, startedAt: event.timestamp, endedAt: event.timestamp,
  }));
}
export interface RecordedGesture {
  type: 'operation' | 'unsupported'; startedAt: number; endedAt: number;
  tool?: string; arguments?: Record<string, unknown>; reason?: string;
  points: Array<{ x: number; y: number; timestamp: number }>;
}
// Keep raw points: a straight swipe is an approximation of a possibly curved path.
export function translateTouches(events: NativeObservationEvent[]): RecordedGesture[] {
  const active = new Map<string, { start: number; points: RecordedGesture['points']; multi: boolean; scrolling: boolean }>();
  const result: RecordedGesture[] = [];
  for (const event of events) {
    if (event.type !== 'touch') continue;
    for (const t of event.touches) if (t.phase === 0) active.set(t.id, { start: t.touchTimestamp, points: [], multi: false, scrolling: false });
    if (active.size > 1) for (const state of active.values()) state.multi = true;
    for (const t of event.touches) {
      const state = active.get(t.id);
      if (!state) continue;
      state.scrolling ||= t.scrollViews?.some(view => [1, 2, 3].includes(view.panState)) ?? false;
      state.points.push({ x: t.x, y: t.y, timestamp: t.touchTimestamp });
      if (t.phase !== 3 && t.phase !== 4) continue;
      active.delete(t.id);
      const first = state.points[0], last = state.points.at(-1)!;
      const duration = Math.max(0, (t.touchTimestamp - state.start) / 1000);
      const base = { startedAt: state.start, endedAt: t.touchTimestamp, points: state.points };
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
    endedAt: state.points.at(-1)?.timestamp ?? state.start, points: state.points, reason: 'Incomplete touch: no end received.' });
  return result.sort((a, b) => a.startedAt - b.startedAt);
}
export interface ObservationSnapshot {
  timeline: string;
  handshake: { type: 'ready'; timeline: string; protocol: number; bundleId: string; pid?: number };
  samples: NativeObservationEvent[];
}
export function parseObservationSnapshot(text: string, timeline: string): ObservationSnapshot {
  const snapshot = JSON.parse(text);
  if (!timelinePattern.test(timeline) || snapshot.timeline !== timeline || !Array.isArray(snapshot.samples)) throw new Error('Observation timeline mismatch or invalid samples.');
  const handshake = snapshot.handshake;
  if (!handshake || handshake.type !== 'ready' || handshake.timeline !== timeline || ![4, 5, 6].includes(handshake.protocol)) throw new Error('Invalid observation handshake/timeline.');
  if (handshake.protocol < 6 && Number.isFinite(handshake.time)) { handshake.timestamp = Math.round(handshake.time); delete handshake.time; }
  for (const e of snapshot.samples) {
    // Protocol 4/5 already stored native event time as epoch milliseconds.
    if (handshake.protocol < 6 && e.timestamp === undefined && Number.isFinite(e.time)) { e.timestamp = Math.round(e.time); delete e.time; }
    if (handshake.protocol < 6 && Array.isArray(e.touches)) for (const touch of e.touches) {
      touch.touchTimestamp ??= e.timestamp; delete touch.touchTime;
    }
    if (e.timeline !== timeline) throw new Error('Observation event timeline mismatch.');
    if (e.type === 'limit') throw new Error('Native touch event limit reached (100000 events).');
    if (['editing_begin', 'text_change', 'editing_end'].includes(e.type) && handshake.protocol >= 5) {
      const d = e.details;
      if (!Number.isFinite(e.timestamp) || !d || !d.target || typeof d.target.type !== 'string' ||
        !(d.target.elementId === null || typeof d.target.elementId === 'string') ||
        !d.target.frame || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(d.target.frame[k])) ||
        typeof d.redacted !== 'boolean' || typeof d.composing !== 'boolean' || !Number.isInteger(d.textLength) || d.textLength < 0 ||
        !(d.redacted ? d.text === null : typeof d.text === 'string' && d.text.length === d.textLength) ||
        !['agent', 'app_or_user'].includes(d.source) || (d.requestId !== undefined && typeof d.requestId !== 'string')) throw new Error('Invalid observation editing event data');
      continue;
    }
    if (e.type !== 'touch' || !Number.isFinite(e.timestamp) || !Array.isArray(e.touches) || e.touches.length > 20 ||
      !e.touches.every((t: TouchPoint) => typeof t.id === 'string' && [0, 1, 2, 3, 4].includes(t.phase) &&
        [t.x, t.y, t.touchTimestamp].every(Number.isFinite) && Number.isInteger(t.tapCount) && t.tapCount >= 0 &&
        (t.scrollViews === undefined || Array.isArray(t.scrollViews) && t.scrollViews.every(view => typeof view.id === 'string' && Number.isInteger(view.panState) && view.panState >= 0 && view.panState <= 5 && [view.offsetX, view.offsetY].every(Number.isFinite))))) throw new Error('Invalid observation event data');
  }
  return snapshot;
}
export interface ObservationEvent extends OperationRecord {
  points?: RecordedGesture['points'];
  reason?: string;
  captureIndex?: number;
  error?: string;
}
export function observationEvents(gestures: RecordedAction[], captures: Array<{type: 'capture'; captureIndex: number; startedAt: number; endedAt: number; error?: string}>, timeline: TimelineId, startedAt: number): ObservationEvent[] {
  const entries = [
    ...gestures.map(({ type, tool, arguments: args, ...gesture }) => ({ ...gesture, tool: type === 'operation' ? tool! : 'unsupported', arguments: args ?? {} })),
    ...captures.map(({ type, ...frame }) => ({ ...frame, tool: 'capture', arguments: {} })),
  ];
  return withTimestampTiming(entries, timeline, startedAt);
}
export function operationChain(source: RecordedAction[] | OperationRecord[], origin?: number, timing: OperationSettings = defaultOperationSettings) {
  const timeline = createTimeline('chain');
  const records: OperationRecord[] = source.length && 'startedAt' in source[0]
    ? observationEvents(source as RecordedAction[], [], createTimeline('session'), origin ?? (source[0] as RecordedAction).startedAt)
    : source as OperationRecord[];
  let previousStart = records.length ? records[0].timestamp - records[0].interval * 1000 : 0;
  const steps = records.filter(record => record.tool !== 'unsupported').map((record, index) => {
    const interval = (record.timestamp - previousStart) / 1000;
    previousStart = record.timestamp;
    return { index, tool: record.tool, arguments: record.arguments, interval, timestamp: record.timestamp, duration: record.duration };
  });
  let error: string | undefined;
  try {
    if (source.length !== steps.length) throw new Error('Unsupported observations cannot be replayed.');
    prepareSteps(steps, [...gesturesTools, ...captureTools, ...screenshotTools], timeline, timing);
  } catch (failure) { error = (failure as Error).message; }
  return { timeline, steps, replayable: !error, ...(error ? { error } : {}),
    note: 'Candidate replay only. interval is start-to-start, duration never adds to interval. Backend timing and trajectories may differ. Unsupported operations or limits require adaptation; overlapping non-image commands fail at execution.' };
}
