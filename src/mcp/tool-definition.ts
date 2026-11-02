import type { ScreenshotSettingsStore } from '../setting/screenshot-settings.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { IDBClient } from '../operation/idb-client.js';

export interface ToolDefinition {
  definition: Tool;
  responseType?: 'mcp';
  execute(client: IDBClient, args: Record<string, unknown>, settings: ScreenshotSettingsStore): Promise<unknown>;
}
