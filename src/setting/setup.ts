import { pruneScreenshots } from '../storage/screenshot-history.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import { historyDirectory, settingsSchema } from './screenshot-settings.js';

export const settingsTools: ToolDefinition[] = [{
  definition: {
    name: 'setup',
    description: 'View or update persistent isimbot screenshot settings. Call with {} to read; supply only fields to change. Applies to future screenshots across sessions. Does not modify Claude Code or Codex MCP registration.',
    inputSchema: { type: 'object', properties: settingsSchema, additionalProperties: false },
  },
  async execute(_client, args, settings) {
    const configuration = settings.update(args);
    const deletedOldImages = Object.hasOwn(args, 'maxSavedImages') ? pruneScreenshots(historyDirectory(settings), configuration.maxSavedImages) : 0;
    return { historyDirectory: historyDirectory(settings), deletedOldImages, success: true, configuration, configPath: settings.path, scope: 'user; persists across server restarts', changed: Object.keys(args).length > 0 };
  },
}];
