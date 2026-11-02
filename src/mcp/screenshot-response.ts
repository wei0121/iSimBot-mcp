import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ScreenshotSettings } from '../setting/screenshot-settings.js';
import { processScreenshot } from '../image/process-screenshot.js';

export async function screenshotResult(path: string, settings: ScreenshotSettings): Promise<CallToolResult> {
  const image = await processScreenshot(path, settings);
  return { content: [
    { type: 'text', text: JSON.stringify(image.metadata, null, 2) },
    { type: 'image', mimeType: image.mimeType, data: image.data },
  ] };
}
