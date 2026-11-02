import { ScreenshotSettingsStore } from '../setting/screenshot-settings.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { IDBClient } from '../operation/idb-client.js';
import { tools } from './registry.js';
import { version } from '../version.js';

export function createServer(client = new IDBClient(), settings = new ScreenshotSettingsStore()): Server {
  const server = new Server(
    { name: 'iSimBot-MCP', version },
    { capabilities: { tools: {} } },
  );
  const registry = new Map(tools.map(tool => [tool.definition.name, tool]));
  if (registry.size !== tools.length) throw new Error('Duplicate MCP tool name');

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => tool.definition),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const { name, arguments: args } = request.params;
      const tool = registry.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const result = await tool.execute(client, args || {}, settings);
      if (tool.responseType === 'mcp') return result as CallToolResult;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: false, error: (error as Error).message,
        }, null, 2) }],
        isError: true,
      };
    }
  });
  return server;
}

export async function startServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  console.error('iSimBot-MCP server running on stdio');
}
