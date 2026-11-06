import type { ScreenRead } from '../common/capture.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerScreenshot, screenshotCoordinateEpoch } from '../image/screenshot-coordinates.js';
import type { IDBClient } from './idb-client.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import { historyDirectory, settingsSchema, validateSettings, type ScreenshotSettingsStore, type ScreenshotSettings } from '../setting/screenshot-settings.js';
import { beginScreenshot, pruneScreenshots } from '../storage/screenshot-history.js';
import { screenshotResult } from '../mcp/screenshot-response.js';

export async function captureScreenshot(client: IDBClient, settings: ScreenshotSettingsStore, outputPath?: string, overrides: Partial<Omit<ScreenshotSettings, 'maxSavedImages'>> = {}, read?: (path: string) => Promise<ScreenRead>) {
  let frame: ScreenRead | undefined;
  const acquire = async (path: string) => {
    if (read) { frame = await read(path); return frame.path; }
    return client.screenshot(path);
  };
  const annotate = (result: CallToolResult, path: string) => {
    const timing = client.getScreenshotTiming?.(path) ?? (frame ? { timestamp: frame.timestamp, captureTiming: frame.captureTiming } : undefined);
    return timing ? { ...result, structuredContent: { ...result.structuredContent, ...timing } } : result;
  };
  const coordinateEpoch = screenshotCoordinateEpoch(client);
  const configuration = { ...settings.read(), ...validateSettings(overrides) };
  if (outputPath !== undefined) {
    if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('path must be a non-empty string');
    const path = await acquire(outputPath);
    const geometry = client.getScreenshotGeometry?.(path);
    return annotate(registerScreenshot(client, await screenshotResult(path, configuration, geometry, client.getConnectedDevice?.()), geometry, coordinateEpoch), path);
  }
  const dir = historyDirectory(settings);
  const capture = beginScreenshot(dir);
  const pending = capture.pending;
  try {
    await acquire(pending);
    // Finish reading the image before exposing it to cleanup by other calls.
    const geometry = client.getScreenshotGeometry?.(pending);
    const result = await screenshotResult(pending, configuration, geometry, client.getConnectedDevice?.());
    capture.commit();
    pruneScreenshots(dir, settings.read().maxSavedImages);
    return annotate(registerScreenshot(client, result, geometry, coordinateEpoch), pending);
  } finally { capture.discard(); }
}

export const imageDescription = 'Images are returned in content and metadata in structuredContent. Single mode: {screenshotId, mode, imageSize, deviceInfo: {deviceId, screenSize, scale}}. Both: {images: [logical metadata, pixel metadata]}. screenSize is in logical points; imageSize in pixels. Pass screenshotId with image-pixel coordinates to gestures for conversion. References expire after 5 minutes, newest 20 per device; recapture after rotation/navigation. Default PNG, 5 MB per image; never silently resize to meet the byte limit. Format, quality and maxBytes use saved settings unless overridden for this call. timestamp is the image backend-read start in Unix milliseconds; captureTiming records backend startedAt/finishedAt windows before image encoding.';

export function imageInputSchema(name: 'screenshot' | 'capture'): ToolDefinition['definition']['inputSchema'] {
  return {
      type: 'object', additionalProperties: false,
      properties: {
        mode: { ...settingsSchema.mode, default: name === 'screenshot' ? 'pixel' : 'logical', description: name === 'screenshot' ? 'Defaults to pixel (original dimensions); logical and both are explicit overrides.' : 'Defaults to saved mode (logical initially); pixel or both are optional overrides.' },
        format: settingsSchema.format,
        quality: settingsSchema.quality,
        maxBytes: settingsSchema.maxBytes,
        path: { type: 'string', description: 'Optional original PNG output path. Explicit paths are not auto-deleted; otherwise managed history retention applies.' },
      },
      required: [],
    };
}

export function parseImageArguments(name: string, args: Record<string, unknown>) {
  const { path, ...overrides } = args;
  const unknown = Object.keys(overrides).find(key => !['mode', 'format', 'quality', 'maxBytes'].includes(key));
  if (unknown) throw new Error(`Unknown ${name} argument: ${unknown}. Use path, mode, format, quality or maxBytes.`);
  return { path: path as string | undefined, configuration: validateSettings(overrides) };
}

export const screenshotTools: ToolDefinition[] = [{
  definition: {
    name: 'screenshot',
    description: 'Take a screenshot only, without reading accessibility. Default mode pixel: original native dimensions, regardless of saved mode. Explicit mode can request logical or both. ' + imageDescription,
    inputSchema: imageInputSchema('screenshot'),
  },
  responseType: 'mcp',
  async execute(client, args, settings): Promise<CallToolResult> {
    const { path, configuration } = parseImageArguments('screenshot', args);
    return captureScreenshot(client, settings, path, { mode: 'pixel', ...configuration });
  },
}];
