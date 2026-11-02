import type { IDBClient } from './idb-client.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import { historyDirectory, type ScreenshotSettingsStore } from '../setting/screenshot-settings.js';
import { beginScreenshot, pruneScreenshots } from '../storage/screenshot-history.js';
import { screenshotResult } from '../mcp/screenshot-response.js';

export async function captureScreenshot(client: IDBClient, settings: ScreenshotSettingsStore, outputPath?: string) {
  const configuration = settings.read();
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
      description: 'Return a screenshot image and metadata using settings from the setup tool. The path points to the unmodified original PNG.',
      inputSchema: {
        type: 'object',
        properties: {
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
      return captureScreenshot(idbClient, settings, args.path as string | undefined);
    },
  },
];
