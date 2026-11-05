import { defaultOperationSettings, type OperationSettings } from '../setting/operation-settings.js';
import { ToolError } from '../mcp/tool-error.js';
import { randomBytes } from 'node:crypto';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import { validateArguments } from '../mcp/validate-arguments.js';

export type ParentId = `session_${string}` | `chain_${string}`;
export interface Operation {
  tool: string;
  arguments: Record<string, unknown>;
}
export interface OperationRecord extends Operation {
  parentId: ParentId;
  time: number;
  delay: number;
  duration: number;
}
export const parentIdPattern = /^(session|chain)_[0-9a-f]{8}$/;
export function createParentId(kind: 'session' | 'chain'): ParentId { return `${kind}_${randomBytes(4).toString('hex')}`; }
export const imageTools = new Set(['capture', 'screenshot']);
export const excludedChainTools = new Set(['start_observation', 'stop_observation', 'get_observation', 'setup', 'operation_chain', 'boot_simulator', 'shutdown_simulator', 'list_devices']);
export const chainLimits = { steps: 20, images: 6, delay: 10, totalDelay: 30 };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function minimumInterval(step: Operation, settings: OperationSettings): number {
  const defaults: Record<string, number> = { long_press: 1, swipe: 0.5, pinch: 0.5 };
  const requested = step.tool in defaults ? Number(step.arguments.duration ?? defaults[step.tool]) : 0;
  return Math.max(settings.minDelay[step.tool] ?? 0, requested > 0 ? requested + 0.2 : 0);
}

// Used for executable requests and observed replay candidates alike.
export function prepareSteps(raw: unknown, operations: ToolDefinition[], parentId: ParentId, settings: OperationSettings = defaultOperationSettings): OperationRecord[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > chainLimits.steps) throw new Error('Provide steps: an array of 1–20 operations.');
  const registry = new Map(operations.filter(t => !excludedChainTools.has(t.definition.name)).map(t => [t.definition.name, t]));
  let time = 0;
  let sourceParent: unknown;
  let previousCommand: OperationRecord | undefined;
  const steps = raw.map((item, index): OperationRecord => {
    if (!object(item) || Object.keys(item).some(key => !['parentId', 'tool', 'arguments', 'delay', 'time', 'duration'].includes(key))) throw new Error(`Invalid step ${index + 1}`);
    if (typeof item.tool !== 'string' || !registry.has(item.tool)) throw new Error(`Unsupported tool at step ${index + 1}: ${item.tool}`);
    const args = item.arguments === undefined ? {} : item.arguments;
    if (!object(args)) throw new Error(`Invalid arguments at step ${index + 1}`);
    const minimum = previousCommand && !imageTools.has(item.tool) ? minimumInterval(previousCommand, settings) : 0;
    const minimumDelay = previousCommand ? Math.max(0, previousCommand.time + minimum - time) : 0;
    const delay = item.delay === undefined ? Math.max(0.3, minimumDelay) : item.delay;
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > chainLimits.delay) throw new Error('delay must be between 0 and 10 seconds.');
    const interval = previousCommand ? time + delay - previousCommand.time : 0;
    if (previousCommand && !imageTools.has(item.tool) && interval + 0.000001 < minimum) {
      throw new ToolError(`Step ${index + 1} (${item.tool}) starts ${interval.toFixed(3)}s after ${previousCommand.tool} started; minimum is ${minimum.toFixed(3)}s. Set this step delay to at least ${minimumDelay.toFixed(3)}s. No operations were executed.`,
        { code: 'MIN_OPERATION_DELAY', step: index + 1, previousTool: previousCommand.tool, tool: item.tool, requiredInterval: minimum, providedInterval: interval, minimumDelay });
    }
    time += delay;
    if (item.time !== undefined && (typeof item.time !== 'number' || !Number.isFinite(item.time) || Math.abs(item.time - time) > 0.000001)) throw new Error(`Step ${index + 1}: time must equal the sum of delays from the parent start.`);
    if (item.duration !== undefined && (typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration < 0)) throw new Error(`Invalid duration at step ${index + 1}`);
    if (item.parentId !== undefined) {
      if (typeof item.parentId !== 'string' || !parentIdPattern.test(item.parentId)) throw new Error(`Invalid parentId at step ${index + 1}`);
      sourceParent ??= item.parentId;
      if (item.parentId !== sourceParent) throw new Error('All input steps must belong to the same parentId.');
    }
    validateArguments(registry.get(item.tool)!, args);
    const step = { parentId, tool: item.tool, arguments: args, delay, time, duration: 0 };
    if (!imageTools.has(step.tool)) previousCommand = step;
    return step;
  });
  if (time > chainLimits.totalDelay) throw new Error('Total delay (including defaults) cannot exceed 30 seconds.');
  if (steps.filter(step => imageTools.has(step.tool)).length > chainLimits.images) throw new Error('At most 6 screenshot/capture calls combined per chain.');
  return steps;
}

export function withRelativeTiming<T extends Operation & { startedAt: number; endedAt: number }>(entries: T[], parentId: ParentId, origin: number): Array<Omit<T, 'startedAt' | 'endedAt'> & OperationRecord> {
  let previousStart = origin;
  return [...entries].sort((a, b) => a.startedAt - b.startedAt).map(({ startedAt, endedAt, ...entry }) => {
    const result = { ...entry, parentId, time: (startedAt - origin) / 1000, delay: (startedAt - previousStart) / 1000, duration: Math.max(0, (endedAt - startedAt) / 1000) };
    previousStart = startedAt;
    return result;
  });
}
