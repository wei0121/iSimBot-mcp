import type { ScreenshotGeometry } from './coordinate-mapping.js';
import sharp from 'sharp';
import { ToolError } from '../mcp/tool-error.js';
import type { ScreenshotSettings } from '../setting/screenshot-settings.js';

export async function processScreenshot(path: string, settings: ScreenshotSettings, geometry?: ScreenshotGeometry) {
  const source = sharp(path);
  const original = await source.metadata();
  if (!original.width || !original.height) throw new Error('Cannot determine screenshot dimensions');
  const scale = geometry?.scale;
  const logicalSize = scale && Number.isFinite(scale) && scale > 0
    ? { width: original.width / scale, height: original.height / scale } : null;
  if (settings.mode !== 'pixel' && (!logicalSize || !Number.isInteger(logicalSize.width) || !Number.isInteger(logicalSize.height))) {
    throw new ToolError('Cannot produce a 1:1 logical image without reliable integer screen dimensions. Retry with mode pixel, or update idb/companion.', { code: 'LOGICAL_SIZE_UNAVAILABLE', retry: { tool: 'screenshot', arguments: { mode: 'pixel' } } });
  }
  const width = settings.mode === 'pixel' ? original.width : logicalSize!.width;
  const height = settings.mode === 'pixel' ? original.height : logicalSize!.height;
  if (width * height > 100_000_000) throw new Error('Image exceeds the 100 megapixel processing limit.');
  let quality = settings.quality;
  let actualBytes = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    let pipeline = source.clone().resize({ width, height, fit: 'fill' });
    pipeline = settings.format === 'png' ? pipeline.png({ compressionLevel: 9 }) : pipeline.flatten({ background: '#ffffff' }).jpeg({ quality });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    actualBytes = data.length;
    if (data.length <= settings.maxBytes) {
      const base64 = data.toString('base64');
      return { metadata: {
          deviceInfo: { deviceId: geometry?.udid ?? null, screenSize: logicalSize, scale: logicalSize ? geometry!.scale : null },
          imageSize: { width: info.width, height: info.height },
        }, mimeType: `image/${settings.format}`, data: base64 };

    }
    if (settings.format === 'jpeg' && quality > 40) { quality = Math.max(40, quality - 10); continue; }
    break;
  }
  const retryArguments = { mode: settings.mode, format: 'jpeg', quality: 60, maxBytes: 5_000_000 };
  throw new ToolError(
    `Screenshot exceeds maxBytes at the requested dimensions: ${actualBytes} bytes > ${settings.maxBytes} bytes (${width}x${height}, ${settings.format}, mode ${settings.mode}). No image returned; dimensions were not silently changed. Retry screenshot with the suggested arguments; setup is not required.`,
    { code: 'SCREENSHOT_TOO_LARGE', actualBytes, maxBytes: settings.maxBytes,
      dimensions: { width, height }, settings, appliedQuality: settings.format === 'jpeg' ? quality : undefined,
      allowedMaxBytes: { minimum: 10000, maximum: 5000000 },
      retry: { tool: 'screenshot', arguments: retryArguments, note: 'Estimated smaller output, not guaranteed to fit. Overrides apply only to the retry; saved settings remain unchanged.' } },
  );
}
