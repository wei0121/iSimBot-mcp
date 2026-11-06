import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainCaptureStore, chainDirectory, type ChainCapture } from '../storage/chain-captures.js';
import { saveTimelineCapture, type StoredCapture } from '../storage/timeline-images.js';
import { presentElements, resolveElementDetail, elementDetailSchema, publicEvent } from '../mcp/element-presentation.js';
import { readOperationSettings } from '../setting/operation-settings.js';
import { currentRecording } from './recording.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorResult } from '../mcp/tool-error.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import { createTimeline, excludedChainTools, imageTools, prepareSteps, type OperationRecord } from '../common/operation.js';

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
      description: 'Run steps on one device. delay is the interval from the PREVIOUS step START to this step START, default at least 0.3 seconds (increased when omitted to satisfy per-tool minDelay); first delay is from chain start. time is seconds from chain start; duration is this operation actual elapsed seconds and never added to delay. capture/screenshot may overlap a running gesture. Explicit delays below per-tool minima fail before any operation. Timed gestures require requested duration plus 0.2 seconds before the next non-image operation. Other overlapping commands fail with OPERATION_TIME_CONFLICT rather than silently waiting. Stops launching steps after failure, then waits for started operations to settle; effects are not rolled back. Up to 20 steps, 6 screenshot/capture calls, delay 0–10 seconds each and 30 seconds total. Top-level elementDetail defaults to changes for capture results; number returns counts and list returns compact elements. Changes compare successive capture steps in this chain by index, never completion order, and return comparedToIndex. First capture marks elements appeared; unavailable snapshots report comparison unavailable. Capture images are saved locally and returned as references; call get_images with timeline and event indexes to view them. Standalone capture is unchanged. Screenshot steps still return images directly. Returns index/tool/arguments/delay/time/duration records in events, with timeline only at the top level. index is the zero-based request step position, independent of completion order; time is not an identifier. Parent IDs use chain_xxxxxxxx. Device lifecycle and observation tools are excluded. A recording started by a failed chain is stopped; existing recordings are preserved.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['steps'], properties: {
        elementDetail: { ...elementDetailSchema, description: 'Element presentation for capture steps, shared with get_observation. changes compares full captures in step-index order within this chain; screenshot steps do not reset the baseline.' },
        steps: { type: 'array', minItems: 1, maxItems: 20, items: {
          type: 'object', additionalProperties: false, required: ['tool'], properties: {
            timeline: { type: 'string', description: 'Optional source session_xxxxxxxx or chain_xxxxxxxx. Execution assigns a new chain timeline.' },
            index: { type: 'integer', minimum: 0, description: 'Optional source event index (metadata only). Execution assigns zero-based indexes in request order.' },
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
      if (Object.keys(args).some(key => !['steps', 'elementDetail'].includes(key))) throw new Error('Provide steps and optional elementDetail only.');
      const elementDetail = resolveElementDetail(args.elementDetail);
      const timeline = createTimeline('chain');
      const steps = prepareSteps(args.steps, operations, timeline, readOperationSettings(settings));
      const outcomes: Array<(OperationRecord & Record<string, unknown>) | undefined> = new Array(steps.length);
      const images = new Map<number, CallToolResult['content']>();
      const pending: Promise<void>[] = [];
      const storedCaptures = new Map<number, StoredCapture>();
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
          outcomes[index] = { ...record, success: false, code: 'OPERATION_TIME_CONFLICT', error: 'Previous non-image operation is still running at this requested start time. Increase delay or move the operation; no automatic postponement was performed.' };
          failed = true; signalFailure(); break;
        }
        if (!image) busy = true;
        const task = (async () => {
          let temporary: string | undefined;
          try {
            const tool = registry.get(step.tool)!;
            let parameters = step.arguments;
            if (step.tool === 'capture' && parameters.path === undefined) {
              temporary = mkdtempSync(join(tmpdir(), 'isimbot-chain-capture-'));
              parameters = { ...parameters, path: join(temporary, 'original.png') };
            }
            const result = await tool.execute(client, parameters, settings);
            if (step.tool === 'start_recording' && object(result) && result.success === true) ownedRecording = currentRecording(client);
            if (tool.responseType === 'mcp') {
              const response = result as CallToolResult;
              if (step.tool === 'capture' && !response.isError) {
                storedCaptures.set(index, saveTimelineCapture(chainDirectory(settings), timeline, index, response));
              }
              const returnedContent = step.tool === 'capture' ? response.content.filter(c => c.type !== 'image') : response.content;
              const bytes = returnedContent.reduce((sum, item) => sum + (item.type === 'image' ? item.data.length : 0), 0);
              if (imageBytes + bytes > 16_000_000) throw new Error('Chain image payload exceeds 16 MB of Base64. Use logical mode, lower maxBytes, or fewer screenshots.');
              imageBytes += bytes;
              images.set(index, [{ type: 'text', text: `Event index ${index}: ${step.tool}` }, ...returnedContent]);
              outcomes[index] = { ...record, success: !response.isError, ...(response.structuredContent ? { result: response.structuredContent } : {}) };
              if (response.isError) { failed = true; signalFailure(); }
            } else {
              const success = !object(result) || result.success !== false;
              outcomes[index] = { ...record, success, result };
              if (!success) { failed = true; signalFailure(); }
            }
          } catch (error) {
            outcomes[index] = { ...record, ...errorResult(error) };
            failed = true; signalFailure();
          } finally {
            if (temporary) rmSync(temporary, { recursive: true, force: true });
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
      // Project only after all started steps settle: retain raw snapshots for
      // comparisons and use request indexes even when captures finish out of order.
      let previousCapture: { index: number; metadata: CallToolResult['structuredContent'] } | undefined;
      const rawEvents = outcomes.filter((step): step is OperationRecord & Record<string, unknown> => step !== undefined);
      const captures: ChainCapture[] = rawEvents.filter(e => storedCaptures.has(e.index)).map(e => ({ index: e.index, time: e.time, capture: storedCaptures.get(e.index)! }));
      if (captures.length) {
        try { new ChainCaptureStore(chainDirectory(settings)).save({ timeline, udid: client.getConnectedDevice?.() ?? null, eventCount: rawEvents.length, captures }); }
        catch (error) { failed = true; rawEvents[0].storageError = `Could not save image catalog: ${(error as Error).message}. Images remain in ${chainDirectory(settings)}.`; }
      }
      const completed = rawEvents.map(record => {
        const step = publicEvent(record) as Omit<OperationRecord, 'timeline'> & Record<string, unknown>;
        if (step.tool !== 'capture') return step;
        const previous = previousCapture;
        const metadata = object(step.result) ? step.result : undefined;
        previousCapture = { index: step.index, metadata };
        const comparison = elementDetail === 'changes' ? { comparedToIndex: previous?.index ?? null } : {};
        const { result: _result, ...event } = step;
        const presentation = presentElements(metadata, previous?.metadata, elementDetail, previous !== undefined);
        return { ...event, ...comparison, images: storedCaptures.get(step.index)?.images ?? [], ...presentation,
          ...(event.error ? { error: [event.error, presentation.error].filter(Boolean).join(' ') } : {}) };
      });
      const summary = { timeline, elementDetail, success: !failed, totalEvents: completed.length, events: completed, skippedSteps: steps.length - completed.length,
        ...(recordingCleanup ? { recordingCleanup } : {}),
        ...(failed ? { note: 'Stopped launching steps after failure; already started operations were allowed to finish. Nothing was rolled back.' } : {}),
      };
      return { structuredContent: summary, ...(failed ? { isError: true } : {}), content: [
        { type: 'text', text: JSON.stringify({ ...summary, events: completed.map(({ result, ...step }) => imageTools.has(step.tool) ? step : { ...step, ...(result !== undefined ? { result } : {}) }) }, null, 2) },
        ...[...images.entries()].sort(([a], [b]) => a - b).flatMap(([, content]) => content),
      ] };
    },
  };
}
