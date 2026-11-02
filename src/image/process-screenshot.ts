import sharp from 'sharp';
import { ToolError } from '../mcp/tool-error.js';
import type { ScreenshotSettings } from '../setting/screenshot-settings.js';

export async function processScreenshot(path: string, settings: ScreenshotSettings) {
  const source = sharp(path);
  const original = await source.metadata();
  if (!original.width || !original.height) throw new Error('Cannot determine screenshot dimensions');
  const width = Math.max(1, Math.round(original.width * settings.scale));
  const height = Math.max(1, Math.round(original.height * settings.scale));
  if (width * height > 100_000_000) throw new Error('Requested scale exceeds the 100 megapixel processing limit; choose a smaller scale.');
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
          success: true, path, originalWidth: original.width, originalHeight: original.height,
          returnedWidth: info.width, returnedHeight: info.height, format: settings.format,
          bytes: data.length, base64Bytes: base64.length, settings,
          ...(settings.format === 'jpeg' ? { appliedQuality: quality } : {}),
          originalPixelsPerReturnedPixel: { x: original.width / info.width, y: original.height / info.height },
          coordinateNote: 'Scaling maps returned pixels to original screenshot pixels only. Simulator touch coordinates may use points; do not assume they match screenshot pixels.',
        }, mimeType: `image/${settings.format}`, data: base64 };
    }
    if (settings.format === 'jpeg' && quality > 40) { quality = Math.max(40, quality - 10); continue; }
    break;
  }
  const retryScale = Math.max(0.1, Math.floor(settings.scale * Math.sqrt(settings.maxBytes / actualBytes) * 0.8 * 100) / 100);
  const retryArguments = { scale: retryScale, format: 'jpeg', quality: 60, maxBytes: settings.maxBytes };
  throw new ToolError(
    `Screenshot exceeds maxBytes at the requested scale: ${actualBytes} bytes > ${settings.maxBytes} bytes (${width}x${height}, ${settings.format}, scale ${settings.scale}). No image returned; scale was not silently changed. Retry screenshot with the suggested arguments; setup is not required.`,
    { code: 'SCREENSHOT_TOO_LARGE', actualBytes, maxBytes: settings.maxBytes,
      dimensions: { width, height }, settings, appliedQuality: settings.format === 'jpeg' ? quality : undefined,
      allowedMaxBytes: { minimum: 10000, maximum: 5000000 },
      retry: { tool: 'screenshot', arguments: retryArguments, note: 'Estimated smaller output, not guaranteed to fit. Overrides apply only to the retry; saved settings remain unchanged.' } },
  );
}
