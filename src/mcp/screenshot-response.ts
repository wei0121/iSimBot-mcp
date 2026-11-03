import type { ScreenshotGeometry } from '../image/coordinate-mapping.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ScreenshotSettings } from '../setting/screenshot-settings.js';
import { processScreenshot } from '../image/process-screenshot.js';

export async function screenshotResult(path: string, settings: ScreenshotSettings, geometry?: ScreenshotGeometry, deviceId?: string | null): Promise<CallToolResult> {
  const content: CallToolResult['content'] = [];
  const images: Record<string, unknown>[] = [];
  const modes = settings.mode === 'both' ? ['logical', 'pixel'] as const : [settings.mode];
  for (const mode of modes) {
    const image = await processScreenshot(path, { ...settings, mode }, geometry);
    images.push({ mode, ...image.metadata, deviceInfo: { ...image.metadata.deviceInfo, deviceId: geometry?.udid ?? deviceId ?? null } });
    content.push({ type: 'image', mimeType: image.mimeType, data: image.data });
  }
  return { content, structuredContent: settings.mode === 'both' ? { images } : images[0] };
}
