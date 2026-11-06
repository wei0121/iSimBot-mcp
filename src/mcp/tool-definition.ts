import type { ScreenshotSettingsStore } from '../setting/screenshot-settings.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { IDBClient } from '../operation/idb-client.js';

export interface ToolDefinition {
  definition: Tool;
  responseType?: 'mcp';
  /** Extra cross-field checks, also run during whole-chain preflight. */
  validate?(args: Record<string, unknown>): void;
  execute(client: IDBClient, args: Record<string, unknown>, settings: ScreenshotSettingsStore): Promise<unknown>;
}
