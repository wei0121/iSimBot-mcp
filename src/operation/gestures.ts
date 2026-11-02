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
      description: 'Perform pinch gesture (zoom in/out)',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: {
            type: 'number',
            description: 'Center X coordinate',
          },
          y: {
            type: 'number',
            description: 'Center Y coordinate',
          },
          scale: {
            type: 'number',
            description: 'Scale factor (>1 = zoom in, <1 = zoom out, default: 2.0)',
            default: 2,
          },
          duration: {
            type: 'number',
            description: 'Gesture duration in seconds (default: 0.5)',
            default: 0.5,
          },
        },
        required: ['x', 'y'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.pinch(
        args.x as number,
        args.y as number,
        args.scale as number | undefined,
        args.duration as number | undefined
      );
      return { success: true, message: `Pinch gesture at (${args.x}, ${args.y})` };
    },
  },
];

// Keep direct calls and operation-chain calls aligned with the published contract.
for (const tool of gesturesTools) {
  const execute = tool.execute;
  tool.execute = async (client, args, settings) => {
    const schema = tool.definition.inputSchema;
    for (const key of schema.required || []) {
      if (!(key in args)) throw new Error(`${tool.definition.name}: missing argument ${key}`);
    }
    for (const [key, value] of Object.entries(args)) {
      const rule = schema.properties?.[key] as { type: string; enum?: string[] } | undefined;
      if (!rule || (rule.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== rule.type)) {
        throw new Error(`${tool.definition.name}: invalid argument ${key}`);
      }
      if (rule.enum && !rule.enum.includes(value as string)) throw new Error(`Invalid ${key}`);
    }
    return execute(client, args, settings);
  };
}
