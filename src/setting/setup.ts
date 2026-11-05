import { validateSettings } from './screenshot-settings.js';
import { minDelaySchema, validateMinDelay, operationSettingsStore } from './operation-settings.js';
import { pruneScreenshots } from '../storage/screenshot-history.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import { historyDirectory, settingsSchema } from './screenshot-settings.js';

export const settingsTools: ToolDefinition[] = [{
  definition: {
    name: 'setup',
    description: 'View or update persistent isimbot screenshot and operation timing settings. Call with {} to read; supply only fields to change. Applies to future screenshots and chains across sessions. Does not modify Claude Code or Codex MCP registration.',
    inputSchema: { type: 'object', properties: { ...settingsSchema, minDelay: minDelaySchema }, additionalProperties: false },
  },
  async execute(_client, args, settings) {
    const { minDelay, ...imagePatch } = args;
    validateSettings(imagePatch);
    if (minDelay !== undefined) validateMinDelay(minDelay);
    const timing = operationSettingsStore(settings);
    // Validate both patches and existing files before making any change.
    timing.read(); settings.read();
    const operationConfiguration = minDelay === undefined ? timing.read() : timing.update(minDelay);
    const configuration = { ...settings.update(imagePatch), minDelay: operationConfiguration.minDelay };
    const deletedOldImages = Object.hasOwn(args, 'maxSavedImages') ? pruneScreenshots(historyDirectory(settings), configuration.maxSavedImages) : 0;
    return { historyDirectory: historyDirectory(settings), deletedOldImages, success: true, configuration, configPath: settings.path, operationConfigPath: timing.path, scope: 'user; persists across server restarts', changed: Object.keys(args).length > 0 };
  },
}];
