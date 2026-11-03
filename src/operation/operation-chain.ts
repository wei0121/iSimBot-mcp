import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { errorResult } from '../mcp/tool-error.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';

interface Step {
  tool: string;
  arguments: Record<string, unknown>;
  delay: number;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
import { validateArguments } from '../mcp/validate-arguments.js';

export function createOperationChain(
  operations: ToolDefinition[],
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
): ToolDefinition {
  const registry = new Map(operations.filter(t => !['setup', 'operation_chain', 'boot_simulator', 'shutdown_simulator', 'list_devices'].includes(t.definition.name)).map(t => [t.definition.name, t]));
  return {
    definition: {
      name: 'operation_chain',
      description: 'Execute steps sequentially and return all results/images together. Optional delay is the wait after the previous operation completes, before the current operation. Default: 0.3 seconds; 0 means no delay. To inspect animations, follow an action with consecutive screenshot steps using delay: 0.1; screenshot processing time is additional. Stops on failure; completed actions are not rolled back. Up to 20 steps, 6 image-producing calls (screenshot and capture combined), 30 seconds total delay (including defaults). The whole chain runs on one device without interleaving other operations on that device. Device lifecycle and list tools are not allowed inside chains. Screenshot settings and retention still apply.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['steps'],
        properties: {
          steps: {
            type: 'array', minItems: 1, maxItems: 20,
            items: {
              type: 'object', additionalProperties: false, required: ['tool'],
              properties: {
                tool: { type: 'string', enum: [...registry.keys()] },
                arguments: { type: 'object', description: 'Arguments of the selected tool, using its normal schema; defaults to {}.' },
                delay: { type: 'number', minimum: 0, maximum: 10, default: 0.3, description: 'Optional delay in seconds after the previous operation completes, before this operation. Default: 0.3; 0 means no delay.' },
              },
            },
          },
        },
      },
    },
    responseType: 'mcp',
    async execute(client, args, settings): Promise<CallToolResult> {
      if (Object.keys(args).some(key => key !== 'steps') || !Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 20) throw new Error('Provide steps: an array of 1–20 operations.');
      const steps: Step[] = args.steps.map((raw, index) => {
        if (!isObject(raw) || Object.keys(raw).some(key => !['tool', 'arguments', 'delay'].includes(key))) throw new Error(`Invalid step ${index + 1}`);
        if (typeof raw.tool !== 'string' || !registry.has(raw.tool)) throw new Error(`Unsupported tool at step ${index + 1}: ${raw.tool}`);
        const parameters = raw.arguments === undefined ? {} : raw.arguments;
        if (!isObject(parameters)) throw new Error(`Invalid arguments at step ${index + 1}`);
        const delay = raw.delay === undefined ? 0.3 : raw.delay;
        if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 10) throw new Error('delay must be between 0 and 10 seconds.');
        validateArguments(registry.get(raw.tool)!, parameters);
        return { tool: raw.tool, arguments: parameters, delay };
      });
      if (steps.reduce((sum, step) => sum + step.delay, 0) > 30) throw new Error('Total delay (including defaults) cannot exceed 30 seconds.');
      if (steps.filter(step => ['screenshot', 'capture'].includes(String(step.tool))).length > 6) throw new Error('At most 6 screenshot/capture calls combined per chain.');
      const outcomes: Record<string, unknown>[] = [];
      const content: CallToolResult['content'] = [];
      let imageBytes = 0;
      let failed = false;
      for (const [index, step] of steps.entries()) {
        const tool = registry.get(step.tool)!;
        try {
          // The preceding iteration has fully completed; always wait the full
          // relative interval, even when earlier operations were slow.
          if (step.delay) await sleep(step.delay * 1000);
          const result = await tool.execute(client, step.arguments, settings);
          if (tool.responseType === 'mcp') {
            const response = result as CallToolResult;
            const bytes = response.content.reduce((sum, item) => sum + (item.type === 'image' ? item.data.length : 0), 0);
            if (imageBytes + bytes > 16_000_000) throw new Error('Chain image payload exceeds 16 MB of Base64. Use logical mode, lower maxBytes, or fewer screenshots.');
            imageBytes += bytes;
            content.push({ type: 'text', text: `Step ${index + 1}: ${step.tool}` }, ...response.content);
            outcomes.push({ step: index + 1, tool: step.tool, success: !response.isError, ...(response.structuredContent ? { result: response.structuredContent } : {}) });
            if (response.isError) { failed = true; break; }
          } else {
            outcomes.push({ step: index + 1, tool: step.tool, success: true, result });
          }
        } catch (error) {
          outcomes.push({ step: index + 1, tool: step.tool, ...errorResult(error) });
          failed = true;
          break;
        }
      }
      const summary = {
        success: !failed, steps: outcomes, skippedSteps: steps.length - outcomes.length,
        ...(failed ? { note: 'Stopped after failure. Earlier operations may have changed the app; nothing was rolled back.' } : {}),
      };
      return {
        structuredContent: summary,
        ...(failed ? { isError: true } : {}),
        content: [{ type: 'text', text: JSON.stringify({
          success: !failed, steps: outcomes.map(({ result, ...step }) => ['screenshot', 'capture'].includes(String(step.tool)) ? step : { ...step, ...(result !== undefined ? { result } : {}) }), skippedSteps: steps.length - outcomes.length,
          ...(failed ? { note: 'Stopped after failure. Earlier operations may have changed the app; nothing was rolled back.' } : {}),
        }, null, 2) }, ...content],
      };
    },
  };
}
