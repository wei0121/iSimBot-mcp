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
  interval: number;
  duration: number;
}
export const timelinePattern = /^(session|chain)_[0-9a-f]{8}$/;
export function createTimeline(kind: 'session' | 'chain'): TimelineId { return `${kind}_${randomBytes(4).toString('hex')}`; }
export const imageTools = new Set(['capture', 'screenshot']);
export const excludedChainTools = new Set(['get_images', 'start_observation', 'stop_observation', 'get_observation', 'setup', 'operation_chain', 'boot_simulator', 'shutdown_simulator', 'list_devices']);
export const chainLimits = { steps: 100, images: 30, interval: 10, totalInterval: 120 };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function minimumInterval(step: Operation, settings: OperationSettings): number {
  const alias = step.tool === 'device_control' ? ({ rotate: 'rotate', set_location: 'set_location' } as Record<string, string>)[step.arguments.action as string] : undefined;
  const aliasMinimum = alias ? settings.minInterval[alias] ?? 0 : 0;
  const defaults: Record<string, number> = { long_press: 1, swipe: 0.5, pinch: 0.5 };
  const requested = step.tool in defaults ? Number(step.arguments.duration ?? defaults[step.tool]) : 0;
  return Math.max(settings.minInterval[step.tool] ?? 0, aliasMinimum, requested > 0 ? requested + 0.2 : 0);
}

// Used for executable requests and observed replay candidates alike.
export function prepareSteps(raw: unknown, operations: ToolDefinition[], timeline: TimelineId, settings: OperationSettings = defaultOperationSettings, origin = Date.now()): OperationRecord[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > chainLimits.steps) throw new Error('Provide steps: an array of 1–100 operations.');
  const registry = new Map(operations.filter(t => !excludedChainTools.has(t.definition.name)).map(t => [t.definition.name, t]));
  let elapsed = 0;
  let sourceTimeline: unknown;
  let previousCommand: { step: OperationRecord; elapsed: number } | undefined;
  const steps = raw.map((item, index): OperationRecord => {
    if (object(item) && Object.hasOwn(item, 'delay')) throw new ToolError('delay was renamed to interval. Use interval in seconds from the previous operation START; duration is unchanged. No operations were executed.', { code: 'RENAMED_ARGUMENT', argument: 'delay', replacement: 'interval', step: index + 1 });
    if (!object(item) || Object.keys(item).some(key => !['timeline', 'index', 'tool', 'arguments', 'interval', 'timestamp', 'duration'].includes(key))) throw new Error(`Invalid step ${index + 1}`);
    if (item.index !== undefined && (!Number.isInteger(item.index) || (item.index as number) < 0)) throw new Error(`Invalid index at step ${index + 1}`);
    if (typeof item.tool !== 'string' || !registry.has(item.tool)) throw new Error(`Unsupported tool at step ${index + 1}: ${item.tool}`);
    const args = item.arguments === undefined ? {} : item.arguments;
    if (!object(args)) throw new Error(`Invalid arguments at step ${index + 1}`);
    const minimum = previousCommand && !imageTools.has(item.tool) ? minimumInterval(previousCommand.step, settings) : 0;
    const minimumStepInterval = previousCommand ? Math.max(0, previousCommand.elapsed + minimum - elapsed) : 0;
    const interval = item.interval === undefined ? Math.max(0.3, minimumStepInterval) : item.interval;
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0 || interval > chainLimits.interval) throw new Error('interval must be between 0 and 10 seconds.');
    const sincePreviousCommand = previousCommand ? elapsed + interval - previousCommand.elapsed : 0;
    if (previousCommand && !imageTools.has(item.tool) && sincePreviousCommand + 0.000001 < minimum) {
      throw new ToolError(`Step ${index + 1} (${item.tool}) starts ${sincePreviousCommand.toFixed(3)}s after ${previousCommand.step.tool} started; minimum is ${minimum.toFixed(3)}s. Set this step interval to at least ${minimumStepInterval.toFixed(3)}s. No operations were executed.`,
        { code: 'MIN_OPERATION_INTERVAL', step: index + 1, previousTool: previousCommand.step.tool, tool: item.tool, requiredInterval: minimum, providedInterval: sincePreviousCommand, minimumStepInterval });
    }
    elapsed += interval;
    if (item.timestamp !== undefined && (!Number.isSafeInteger(item.timestamp) || (item.timestamp as number) < 0)) throw new Error(`Step ${index + 1}: timestamp must be a nonnegative Unix millisecond integer (source metadata only).`);
    if (item.duration !== undefined && (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration < 0)) throw new Error(`Invalid duration at step ${index + 1}`);
    if (item.timeline !== undefined) {
      if (typeof item.timeline !== 'string' || !timelinePattern.test(item.timeline)) throw new Error(`Invalid timeline at step ${index + 1}`);
      sourceTimeline ??= item.timeline;
      if (item.timeline !== sourceTimeline) throw new Error('All input steps must belong to the same timeline.');
    }
    validateArguments(registry.get(item.tool)!, args);
    const step = { timeline, index, tool: item.tool, arguments: args, interval, timestamp: Math.round(origin + elapsed * 1000), duration: 0 };
    if (!imageTools.has(step.tool)) previousCommand = { step, elapsed };
    return step;
  });
  if (elapsed > chainLimits.totalInterval) throw new Error('Total interval (including defaults) cannot exceed 120 seconds.');
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
    const result = { ...entry, timeline, timestamp: Math.round(startedAt), interval: (startedAt - previousStart) / 1000, duration: Math.max(0, (endedAt - startedAt) / 1000) };
    previousStart = startedAt;
    return result;
  }));
}
