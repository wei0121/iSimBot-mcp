import { typeIntoFocusedField } from './text-input.js';
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
      description: 'Enter text in the focused field. insert (default) replaces the selection or inserts at the cursor; replace replaces the whole field, and text empty with replace clears it. Chinese/Emoji and replace require launch_app enableTextInput:true or start_observation first (explicit app restart), then focus a standard UIKit/SwiftUI field or UISearchBar search field. Unsupported fields return responder class and target diagnostics; a visible keyboard alone does not prove support. No clipboard. Plain apps support ASCII insert via idb only. Native success verifies immediate field text, not later business validation.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['insert', 'replace'], default: 'insert' },
          text: {
            type: 'string',
            description: 'Text to type',
          },
        },
        required: ['text'],
      },
    },
    async execute(idbClient, args) {
      return typeIntoFocusedField(idbClient, args.text as string, args.mode as 'insert' | 'replace' | undefined);
    },
  },
];
