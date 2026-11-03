import { DeviceManager, deviceToolDefinition } from '../operation/device-manager.js';
import { ScreenshotSettingsStore } from '../setting/screenshot-settings.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { IDBClient } from '../operation/idb-client.js';
import { tools } from './registry.js';
import { errorResult } from './tool-error.js';
import { version } from '../version.js';

export function createServer(client = new IDBClient(), settings = new ScreenshotSettingsStore(), createClient: () => IDBClient = () => new IDBClient()): Server {
  const devices = new DeviceManager(client, createClient);
  const server = new Server(
    { name: 'iSimBot-MCP', version },
    { capabilities: { tools: {} } },
  );
  const registry = new Map(tools.map(tool => [tool.definition.name, tool]));
  if (registry.size !== tools.length) throw new Error('Duplicate MCP tool name');

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(deviceToolDefinition),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const { name, arguments: args } = request.params;
      const tool = registry.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const result = await devices.execute(tool, args || {}, settings);
      if (tool.responseType === 'mcp') return result as CallToolResult;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        ...(result && typeof result === 'object' && 'success' in result && result.success === false ? { isError: true } : {}) };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify(errorResult(error), null, 2) }],
        isError: true,
      };
    }
  });
  const close = server.close.bind(server);
  server.close = async () => { await devices.close(); await close(); };
  server.onclose = () => { void devices.close(); };
  return server;
}

export async function startServer(): Promise<void> {
  const server = createServer();
  const shutdown = () => { void server.close().finally(() => process.exit(0)); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
  console.error('iSimBot-MCP server running on stdio');
}
