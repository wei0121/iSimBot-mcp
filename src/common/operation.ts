import { defaultOperationSettings, type OperationSettings } from '../setting/operation-settings.js';
import { ToolError } from '../mcp/tool-error.js';
import { randomBytes } from 'node:crypto';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import { validateArguments } from '../mcp/validate-arguments.js';

export type TimelineId = `session_${string}` | `chain_${string}`;
export interface Operation {
  tool: string;
  arguments: Record<string, unknown>;
}
export interface OperationRecord extends Operation {
  timeline: TimelineId;
  index: number;
  timestamp: number;
  delay: number;
  duration: number;
}
export const timelinePattern = /^(session|chain)_[0-9a-f]{8}$/;
export function createTimeline(kind: 'session' | 'chain'): TimelineId { return `${kind}_${randomBytes(4).toString('hex')}`; }
export const imageTools = new Set(['capture', 'screenshot']);
export const excludedChainTools = new Set(['get_images', 'start_observation', 'stop_observation', 'get_observation', 'setup', 'operation_chain', 'boot_simulator', 'shutdown_simulator', 'list_devices']);
export const chainLimits = { steps: 100, images: 30, delay: 10, totalDelay: 120 };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function minimumInterval(step: Operation, settings: OperationSettings): number {
  const alias = step.tool === 'device_control' ? ({ rotate: 'rotate', set_location: 'set_location' } as Record<string, string>)[step.arguments.action as string] : undefined;
  const aliasMinimum = alias ? settings.minDelay[alias] ?? 0 : 0;
  const defaults: Record<string, number> = { long_press: 1, swipe: 0.5, pinch: 0.5 };
  const requested = step.tool in defaults ? Number(step.arguments.duration ?? defaults[step.tool]) : 0;
  return Math.max(settings.minDelay[step.tool] ?? 0, aliasMinimum, requested > 0 ? requested + 0.2 : 0);
}

// Used for executable requests and observed replay candidates alike.
export function prepareSteps(raw: unknown, operations: ToolDefinition[], timeline: TimelineId, settings: OperationSettings = defaultOperationSettings, origin = Date.now()): OperationRecord[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > chainLimits.steps) throw new Error('Provide steps: an array of 1–100 operations.');
  const registry = new Map(operations.filter(t => !excludedChainTools.has(t.definition.name)).map(t => [t.definition.name, t]));
  let elapsed = 0;
  let sourceTimeline: unknown;
  let previousCommand: { step: OperationRecord; elapsed: number } | undefined;
  const steps = raw.map((item, index): OperationRecord => {
    if (!object(item) || Object.keys(item).some(key => !['timeline', 'index', 'tool', 'arguments', 'delay', 'timestamp', 'duration'].includes(key))) throw new Error(`Invalid step ${index + 1}`);
    if (item.index !== undefined && (!Number.isInteger(item.index) || (item.index as number) < 0)) throw new Error(`Invalid index at step ${index + 1}`);
    if (typeof item.tool !== 'string' || !registry.has(item.tool)) throw new Error(`Unsupported tool at step ${index + 1}: ${item.tool}`);
    const args = item.arguments === undefined ? {} : item.arguments;
    if (!object(args)) throw new Error(`Invalid arguments at step ${index + 1}`);
    const minimum = previousCommand && !imageTools.has(item.tool) ? minimumInterval(previousCommand.step, settings) : 0;
    const minimumDelay = previousCommand ? Math.max(0, previousCommand.elapsed + minimum - elapsed) : 0;
    const delay = item.delay === undefined ? Math.max(0.3, minimumDelay) : item.delay;
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > chainLimits.delay) throw new Error('delay must be between 0 and 10 seconds.');
    const interval = previousCommand ? elapsed + delay - previousCommand.elapsed : 0;
    if (previousCommand && !imageTools.has(item.tool) && interval + 0.000001 < minimum) {
      throw new ToolError(`Step ${index + 1} (${item.tool}) starts ${interval.toFixed(3)}s after ${previousCommand.step.tool} started; minimum is ${minimum.toFixed(3)}s. Set this step delay to at least ${minimumDelay.toFixed(3)}s. No operations were executed.`,
        { code: 'MIN_OPERATION_DELAY', step: index + 1, previousTool: previousCommand.step.tool, tool: item.tool, requiredInterval: minimum, providedInterval: interval, minimumDelay });
    }
    elapsed += delay;
    if (item.timestamp !== undefined && (!Number.isSafeInteger(item.timestamp) || (item.timestamp as number) < 0)) throw new Error(`Step ${index + 1}: timestamp must be a nonnegative Unix millisecond integer (source metadata only).`);
    if (item.duration !== undefined && (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration < 0)) throw new Error(`Invalid duration at step ${index + 1}`);
    if (item.timeline !== undefined) {
      if (typeof item.timeline !== 'string' || !timelinePattern.test(item.timeline)) throw new Error(`Invalid timeline at step ${index + 1}`);
      sourceTimeline ??= item.timeline;
      if (item.timeline !== sourceTimeline) throw new Error('All input steps must belong to the same timeline.');
    }
    validateArguments(registry.get(item.tool)!, args);
    const step = { timeline, index, tool: item.tool, arguments: args, delay, timestamp: Math.round(origin + elapsed * 1000), duration: 0 };
    if (!imageTools.has(step.tool)) previousCommand = { step, elapsed };
    return step;
  });
  if (elapsed > chainLimits.totalDelay) throw new Error('Total delay (including defaults) cannot exceed 120 seconds.');
  if (steps.filter(step => imageTools.has(step.tool)).length > chainLimits.images) throw new Error('At most 30 screenshot/capture calls combined per chain.');
  return steps;
}

/** Shared zero-based position for every event, independent of its tool or timestamp. */
export function withEventIndexes<T>(entries: T[]): Array<T & { index: number }> {
  return entries.map((entry, index) => ({ ...entry, index }));
}

export function withTimestampTiming<T extends Operation & { startedAt: number; endedAt: number }>(entries: T[], timeline: TimelineId, origin: number): Array<Omit<T, 'startedAt' | 'endedAt'> & OperationRecord> {
  let previousStart = origin;
  return withEventIndexes([...entries].sort((a, b) => a.startedAt - b.startedAt).map(({ startedAt, endedAt, ...entry }) => {
    const result = { ...entry, timeline, timestamp: Math.round(startedAt), delay: (startedAt - previousStart) / 1000, duration: Math.max(0, (endedAt - startedAt) / 1000) };
    previousStart = startedAt;
    return result;
  }));
}
