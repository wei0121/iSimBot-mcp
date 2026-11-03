import { registerScreenshot } from '../image/screenshot-coordinates.js';
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
    const geometry = client.getScreenshotGeometry?.(path);
    return registerScreenshot(client, await screenshotResult(path, configuration, geometry, client.getConnectedDevice?.()), geometry);
  }
  const dir = historyDirectory(settings);
  const capture = beginScreenshot(dir);
  const pending = capture.pending;
  try {
    await client.screenshot(pending);
    // Finish reading the image before exposing it to cleanup by other calls.
    const geometry = client.getScreenshotGeometry?.(pending);
    const result = await screenshotResult(pending, configuration, geometry, client.getConnectedDevice?.());
    capture.commit();
    pruneScreenshots(dir, settings.read().maxSavedImages);
    return registerScreenshot(client, result, geometry);
  } finally { capture.discard(); }
}

export const screenshotTools: ToolDefinition[] = [
  {
    definition: {
      name: 'screenshot',
      description: 'Return images in content and metadata in structuredContent. Single mode: {screenshotId, mode, imageSize, deviceInfo: {deviceId, screenSize, scale}}. Both: {images: [logical metadata, pixel metadata]} in the same order as image blocks. screenSize is in points; imageSize in pixels; deviceInfo.scale is native screen pixels per point, identical in logical and pixel modes. Pass screenshotId with image-pixel coordinates to gestures for automatic conversion; no manual math. An ID is returned only when mapping is available. IDs last 5 minutes, newest 20 per device per server session. Recapture after rotation or navigation; references are bound to their device. Optional mode, format, quality and maxBytes override saved settings for this call only (also in operation_chain); no persistent settings change. Default mode logical: image pixels equal touch points; pixel returns native dimensions; both returns logical then pixel from one capture. screenSize and scale are null if unavailable. Default PNG, maxBytes 5000000 per image.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          mode: settingsSchema.mode,
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
      const unknown = Object.keys(overrides).find(key => !['mode', 'format', 'quality', 'maxBytes'].includes(key));
      if (unknown) throw new Error(`Unknown screenshot argument: ${unknown}. Use path, mode, format, quality or maxBytes. Use setup for persistent retention settings.`);
      return captureScreenshot(idbClient, settings, path as string | undefined, validateSettings(overrides));
    },
  },
];
