import type { ToolDefinition } from '../mcp/tool-definition.js';

export const inspectionTools: ToolDefinition[] = [
  {
    definition: {
      name: 'describe_ui',
      description: 'Get the accessibility tree of the current screen',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    async execute(idbClient, args) {
      const uiTree = await idbClient.describeUI();
      return { success: true, uiTree };
    },
  },
  {
    definition: {
      name: 'get_logs',
      description: 'Get device logs',
      inputSchema: {
        type: 'object',
        properties: {
          lines: {
            type: 'integer', minimum: 1, maximum: 10000,
            description: 'Number of lines to retrieve (default: 100)',
          },
        },
        required: [],
      },
    },
    async execute(idbClient, args) {
      const logs = await idbClient.getLogs(args.lines as number | undefined);
      return { success: true, logs };
    },
  },
];
