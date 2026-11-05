import { readOperationSettings } from '../setting/operation-settings.js';
import { currentRecording } from './recording.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorResult } from '../mcp/tool-error.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import { createParentId, excludedChainTools, imageTools, prepareSteps, type OperationRecord } from '../common/operation.js';

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function createOperationChain(
  operations: ToolDefinition[],
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = wait,
  now = () => performance.now(),
): ToolDefinition {
  const registry = new Map(operations.filter(t => !excludedChainTools.has(t.definition.name)).map(t => [t.definition.name, t]));
  return {
    definition: {
      name: 'operation_chain',
      description: 'Run steps on one device. delay is the interval from the PREVIOUS step START to this step START, default at least 0.3 seconds (increased when omitted to satisfy per-tool minDelay); first delay is from chain start. time is seconds from chain start; duration is this operation actual elapsed seconds and never added to delay. capture/screenshot may overlap a running gesture. Explicit delays below per-tool minima fail before any operation. Timed gestures require requested duration plus 0.2 seconds before the next non-image operation. Other overlapping commands fail with OPERATION_TIME_CONFLICT rather than silently waiting. Stops launching steps after failure, then waits for started operations to settle; effects are not rolled back. Up to 20 steps, 6 screenshot/capture calls, delay 0–10 seconds each and 30 seconds total. Returns common parentId/tool/arguments/delay/time/duration records in steps. Parent IDs use chain_xxxxxxxx. Device lifecycle and observation tools are excluded. A recording started by a failed chain is stopped; existing recordings are preserved.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['steps'], properties: {
        steps: { type: 'array', minItems: 1, maxItems: 20, items: {
          type: 'object', additionalProperties: false, required: ['tool'], properties: {
            parentId: { type: 'string', description: 'Optional source session_xxxxxxxx or chain_xxxxxxxx. Execution assigns a new chain parentId.' },
            tool: { type: 'string', enum: [...registry.keys()] },
            arguments: { type: 'object', description: 'Tool arguments. arguments.duration, when supported, is the requested gesture duration.' },
            delay: { type: 'number', minimum: 0, maximum: 10, default: 0.3, description: 'Seconds from previous operation START; first step from chain start. Does not include duration. Explicit values below the previous non-image tool minimum fail preflight. Images do not reset the previous-command interval.' },
            time: { type: 'number', minimum: 0, description: 'Optional source time: must equal cumulative delays. Returned time is the actual start time relative to chain start.' },
            duration: { type: 'number', minimum: 0, description: 'Optional source duration (metadata only). Returned duration is this operation actual elapsed time; it does not affect delay.' },
          },
        } },
      } },
    },
    responseType: 'mcp',
    async execute(client, args, settings): Promise<CallToolResult> {
      if (Object.keys(args).some(key => key !== 'steps')) throw new Error('Provide steps only.');
      const parentId = createParentId('chain');
      const steps = prepareSteps(args.steps, operations, parentId, readOperationSettings(settings));
      const outcomes: Array<(OperationRecord & Record<string, unknown>) | undefined> = new Array(steps.length);
      const images = new Map<number, CallToolResult['content']>();
      const pending: Promise<void>[] = [];
      let busy = false, imageBytes = 0, failed = false;
      let ownedRecording: ReturnType<typeof currentRecording>;
      let recordingCleanup: unknown;
      let signalFailure!: () => void;
      const failure = new Promise<void>(resolve => { signalFailure = resolve; });
      const origin = now();
      let previousStart = origin;
      for (const [index, step] of steps.entries()) {
        if (failed) break;
        // Start-to-start scheduling: elapsed work is not added to the interval.
        const remaining = Math.max(0, previousStart + step.delay * 1000 - now());
        if (remaining > 0) {
          const controller = new AbortController();
          try { await Promise.race([sleep(remaining, controller.signal), failure]); }
          finally { controller.abort(); }
        }
        if (failed) break;
        const startedAt = now();
        const record = { ...step, time: (startedAt - origin) / 1000, delay: (startedAt - previousStart) / 1000, duration: 0 };
        previousStart = startedAt;
        const image = imageTools.has(step.tool);
        if (!image && busy) {
          outcomes[index] = { ...record, step: index + 1, success: false, code: 'OPERATION_TIME_CONFLICT', error: 'Previous non-image operation is still running at this requested start time. Increase delay or move the operation; no automatic postponement was performed.' };
          failed = true; signalFailure(); break;
        }
        if (!image) busy = true;
        const task = (async () => {
          try {
            const tool = registry.get(step.tool)!;
            const result = await tool.execute(client, step.arguments, settings);
            if (step.tool === 'start_recording' && object(result) && result.success === true) ownedRecording = currentRecording(client);
            if (tool.responseType === 'mcp') {
              const response = result as CallToolResult;
              const bytes = response.content.reduce((sum, item) => sum + (item.type === 'image' ? item.data.length : 0), 0);
              if (imageBytes + bytes > 16_000_000) throw new Error('Chain image payload exceeds 16 MB of Base64. Use logical mode, lower maxBytes, or fewer screenshots.');
              imageBytes += bytes;
              images.set(index, [{ type: 'text', text: `Step ${index + 1}: ${step.tool}` }, ...response.content]);
              outcomes[index] = { ...record, step: index + 1, success: !response.isError, ...(response.structuredContent ? { result: response.structuredContent } : {}) };
              if (response.isError) { failed = true; signalFailure(); }
            } else {
              const success = !object(result) || result.success !== false;
              outcomes[index] = { ...record, step: index + 1, success, result };
              if (!success) { failed = true; signalFailure(); }
            }
          } catch (error) {
            outcomes[index] = { ...record, step: index + 1, ...errorResult(error) };
            failed = true; signalFailure();
          } finally {
            outcomes[index]!.duration = Math.max(0, (now() - startedAt) / 1000);
            if (!image) busy = false;
          }
        })();
        pending.push(task);
        // Flush already completed commands (including delay:0), without awaiting
        // a still-running gesture. Images can begin while that gesture continues.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await Promise.all(pending);
      if (failed && ownedRecording?.active) recordingCleanup = await ownedRecording.stop('chain_failed');
      const completed = outcomes.filter((step): step is OperationRecord & Record<string, unknown> => step !== undefined);
      const summary = { parentId, success: !failed, steps: completed, skippedSteps: steps.length - completed.length,
        ...(recordingCleanup ? { recordingCleanup } : {}),
        ...(failed ? { note: 'Stopped launching steps after failure; already started operations were allowed to finish. Nothing was rolled back.' } : {}),
      };
      return { structuredContent: summary, ...(failed ? { isError: true } : {}), content: [
        { type: 'text', text: JSON.stringify({ ...summary, steps: completed.map(({ result, ...step }) => imageTools.has(step.tool) ? step : { ...step, ...(result !== undefined ? { result } : {}) }) }, null, 2) },
        ...[...images.entries()].sort(([a], [b]) => a - b).flatMap(([, content]) => content),
      ] };
    },
  };
}
