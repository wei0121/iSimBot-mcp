import type { ToolDefinition } from '../mcp/tool-definition.js';

export const inputTools: ToolDefinition[] = [
  {
    definition: {
      name: 'press_button',
      description: 'Press a hardware button',
      inputSchema: {
        type: 'object',
        properties: {
          button: {
            type: 'string',
            enum: ['home', 'lock', 'volumeUp', 'volumeDown'],
            description: 'Button to press',
          },
        },
        required: ['button'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.pressButton(args.button as 'home' | 'lock' | 'volumeUp' | 'volumeDown');
      return { success: true, message: `Pressed ${args.button} button` };
    },
  },
  {
    definition: {
      name: 'type_text',
      description: 'Type text into the currently focused input field',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to type',
          },
        },
        required: ['text'],
      },
    },
    async execute(idbClient, args) {
      await idbClient.typeText(args.text as string);
      return { success: true, message: 'Text typed successfully' };
    },
  },
];
