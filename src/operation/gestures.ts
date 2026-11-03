import { mapScreenshotArguments } from '../image/screenshot-coordinates.js';
import { validateArguments } from '../mcp/validate-arguments.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';

export const gesturesTools: ToolDefinition[] = [
  {
    definition: {
      name: 'tap',
      description: 'Tap at specific coordinates on the screen',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: {
            type: 'number',
            description: 'X coordinate',
          },
          y: {
            type: 'number',
            description: 'Y coordinate',
          },
        },
        required: ['x', 'y'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.tap(
        args.x as number,
        args.y as number
      );
      return { success: true, message: `Tapped at (${args.x}, ${args.y})` };
    },
  },
  {
    definition: {
      name: 'double_tap',
      description: 'Double tap at specific coordinates',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: {
            type: 'number',
            description: 'X coordinate',
          },
          y: {
            type: 'number',
            description: 'Y coordinate',
          },
        },
        required: ['x', 'y'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.doubleTap(args.x as number, args.y as number);
      return { success: true, message: `Double tapped at (${args.x}, ${args.y})` };
    },
  },
  {
    definition: {
      name: 'long_press',
      description: 'Long press at specific coordinates',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: {
            type: 'number',
            description: 'X coordinate',
          },
          y: {
            type: 'number',
            description: 'Y coordinate',
          },
          duration: {
            type: 'number',
            description: 'Press duration in seconds (default: 1.0)',
            default: 1,
          },
        },
        required: ['x', 'y'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.longPress(
        args.x as number,
        args.y as number,
        args.duration as number | undefined
      );
      return { success: true, message: `Long pressed at (${args.x}, ${args.y})` };
    },
  },
  {
    definition: {
      name: 'swipe',
      description: 'Swipe from one point to another',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x1: {
            type: 'number',
            description: 'Start X coordinate',
          },
          y1: {
            type: 'number',
            description: 'Start Y coordinate',
          },
          x2: {
            type: 'number',
            description: 'End X coordinate',
          },
          y2: {
            type: 'number',
            description: 'End Y coordinate',
          },
          duration: {
            type: 'number',
            description: 'Swipe duration in seconds (default: 0.5)',
            default: 0.5,
          },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.swipe(
        args.x1 as number,
        args.y1 as number,
        args.x2 as number,
        args.y2 as number,
        args.duration as number | undefined
      );
      return {
        success: true,
        message: `Swiped from (${args.x1}, ${args.y1}) to (${args.x2}, ${args.y2})`,
      };
    },
  },
  {
    definition: {
      name: 'scroll',
      description: 'Scroll by swiping from the supplied start point. Direction describes finger movement, not content movement.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x1: { type: 'number', description: 'Start X coordinate' },
          y1: { type: 'number', description: 'Start Y coordinate' },
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: 'Finger movement direction: up decreases Y, down increases Y, left decreases X, right increases X.',
          },
          distance: {
            type: 'number',
            description: 'Distance in the same coordinate units as x1/y1 (default: 200)',
            default: 200,
          },
        },
        required: ['x1', 'y1', 'direction'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.scroll(
        args.x1 as number,
        args.y1 as number,
        args.direction as 'up' | 'down' | 'left' | 'right',
        args.distance as number | undefined
      );
      return { success: true, message: `Scrolled ${args.direction}` };
    },
  },

  {
    definition: {
      name: 'pinch',
      description: 'Perform a native simultaneous two-finger pinch around x/y. Scale is final finger separation divided by initial separation: >1 spreads fingers (zoom in), <1 brings them together (zoom out). The app decides its actual zoom and limits. No single-finger approximation. Requires native idb pinch support.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['x', 'y'],
        properties: {
          x: { type: 'number', description: 'Center X coordinate' },
          y: { type: 'number', description: 'Center Y coordinate' },
          scale: { type: 'number', minimum: 0.01, maximum: 100, default: 2 },
          duration: { type: 'number', default: 0.5, description: 'Gesture duration in seconds' },
          radius: { type: 'number', minimum: 0.01, maximum: 10000, default: 100, description: 'Initial distance of each finger from the center, in the same units as x/y (default 100). Choose a center/radius so the gesture fits the screen.' },
        },
      },
    },
    async execute(client, args) {
      const scale = (args.scale ?? 2) as number;
      const duration = (args.duration ?? 0.5) as number;
      const radius = (args.radius ?? 100) as number;
      await client.pinch(args.x as number, args.y as number, scale, duration, radius);
      return { success: true, message: `Native pinch at (${args.x}, ${args.y}), scale ${scale}` };
    },
  },

];

// Keep direct calls and operation-chain calls aligned with the published contract.
for (const tool of gesturesTools) {
  for (const [key, rule] of Object.entries(tool.definition.inputSchema.properties || {})) {
    const bounds = rule as Record<string, unknown>;
    if (['x', 'y', 'x1', 'y1', 'x2', 'y2'].includes(key)) bounds.minimum = 0;
    if (key === 'duration') { bounds.minimum = 0.01; bounds.maximum = 5; }
    if (key === 'distance') { bounds.minimum = 0; bounds.maximum = 10000; }
  }
  tool.definition.inputSchema.properties!.screenshotId = { type: 'string', description: 'Optional ID from screenshot. Coordinates (plus scroll distance, default 200, and pinch radius, default 100) then use pixels of that returned image; MCP converts automatically. Without it, use simulator points. Recapture after rotation, navigation or device switching.' };
  tool.definition.description += ' Pass screenshotId to use returned-image pixel coordinates with automatic conversion. Without screenshotId, coordinates and distances use simulator points.';
  const execute = tool.execute;
  tool.execute = async (client, args, settings) => {
    validateArguments(tool, args);
    const parameters = tool.definition.name === 'pinch' ? { ...args, radius: args.radius ?? 100 } : args;
    return execute(client, mapScreenshotArguments(client, parameters), settings);
  };
}
