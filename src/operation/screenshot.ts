import type { IDBClient } from './idb-client.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import { historyDirectory, settingsSchema, validateSettings, type ScreenshotSettingsStore, type ScreenshotSettings } from '../setting/screenshot-settings.js';
import { beginScreenshot, pruneScreenshots } from '../storage/screenshot-history.js';
import { screenshotResult } from '../mcp/screenshot-response.js';

export async function captureScreenshot(client: IDBClient, settings: ScreenshotSettingsStore, outputPath?: string, overrides: Partial<Omit<ScreenshotSettings, 'maxSavedImages'>> = {}) {
  const configuration = { ...settings.read(), ...validateSettings(overrides) };
  if (outputPath !== undefined) {
    if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('path must be a non-empty string');
    const path = await client.screenshot(outputPath);
    return screenshotResult(path, configuration);
  }
  const dir = historyDirectory(settings);
  const capture = beginScreenshot(dir);
  const pending = capture.pending;
  try {
    await client.screenshot(pending);
    // Finish reading the image before exposing it to cleanup by other calls.
    const result = await screenshotResult(pending, configuration);
    const path = capture.commit();
    const deleted = pruneScreenshots(dir, settings.read().maxSavedImages);
    const text = result.content[0];
    if (text.type === 'text') {
      text.text = JSON.stringify({ ...JSON.parse(text.text), path, managed: true, deletedOldImages: deleted }, null, 2);
    }
    return result;
  } finally { capture.discard(); }
}

export const screenshotTools: ToolDefinition[] = [
  {
    definition: {
      name: 'screenshot',
      description: 'Return screenshot image data and metadata. Optional scale, format, quality and maxBytes override saved settings for this call only (also in operation_chain); no persistent settings change. Defaults: scale 0.6, PNG, maxBytes 2000000. The path points to the unmodified original PNG.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          scale: settingsSchema.scale,
          format: settingsSchema.format,
          quality: settingsSchema.quality,
          maxBytes: settingsSchema.maxBytes,
          path: {
            type: 'string',
            description: 'Optional original PNG output path. Explicit paths are not auto-deleted; omitted paths use managed history with maxSavedImages retention.',
          },
        },
        required: [],
      },
    },
    responseType: 'mcp',
    async execute(idbClient, args, settings) {
      const { path, ...overrides } = args;
      const unknown = Object.keys(overrides).find(key => !['scale', 'format', 'quality', 'maxBytes'].includes(key));
      if (unknown) throw new Error(`Unknown screenshot argument: ${unknown}. Use path, scale, format, quality or maxBytes. Use setup for persistent retention settings.`);
      return captureScreenshot(idbClient, settings, path as string | undefined, validateSettings(overrides));
    },
  },
];
