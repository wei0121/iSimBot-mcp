import type { ScreenshotGeometry } from './coordinate-mapping.js';
import { randomUUID } from 'node:crypto';
import type { IDBClient } from '../operation/idb-client.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolError } from '../mcp/tool-error.js';

interface Mapping { udid: string; width: number; height: number; x: number; y: number; expires: number }
const sessions = new WeakMap<IDBClient, Map<string, Mapping>>();
const epochs = new WeakMap<IDBClient, object>();
const changing = new WeakSet<IDBClient>();
export function screenshotCoordinateEpoch(client: IDBClient): object | null {
  if (changing.has(client)) return null;
  let epoch = epochs.get(client);
  if (!epoch) { epoch = {}; epochs.set(client, epoch); }
  return epoch;
}
export function clearScreenshotCoordinates(client: IDBClient) { sessions.delete(client); epochs.set(client, {}); }
export function beginCoordinateChange(client: IDBClient) { clearScreenshotCoordinates(client); changing.add(client); }
export function endCoordinateChange(client: IDBClient) { clearScreenshotCoordinates(client); changing.delete(client); }

export function screenshotDevice(client: IDBClient, id: string): string | undefined {
  const mapping = sessions.get(client)?.get(id);
  return mapping && mapping.expires > Date.now() && mapping.udid === client.getConnectedDevice() ? mapping.udid : undefined;
}

interface ImageInfo {
  screenshotId?: string;
  imageSize: { width: number; height: number };
  deviceInfo: { screenSize: { width: number; height: number } | null; scale: number | null };
}

export function registerScreenshot(client: IDBClient, result: CallToolResult, geometry?: ScreenshotGeometry, epoch: object | null = screenshotCoordinateEpoch(client)): CallToolResult {
  if (!epoch || epoch !== screenshotCoordinateEpoch(client)) return result;
  if (!geometry || !result.structuredContent) return result;
  const entries = (result.structuredContent.images || [result.structuredContent]) as ImageInfo[];
  for (const entry of entries) {
    const { imageSize, deviceInfo: { screenSize } } = entry;
    if (!screenSize) continue;
    const cache = sessions.get(client) || new Map<string, Mapping>();
    const screenshotId = randomUUID();
    cache.set(screenshotId, { udid: geometry.udid, width: imageSize.width, height: imageSize.height,
      x: screenSize.width / imageSize.width, y: screenSize.height / imageSize.height, expires: Date.now() + 300000 });
    while (cache.size > 20) cache.delete(cache.keys().next().value!);
    sessions.set(client, cache);
    entry.screenshotId = screenshotId;
  }
  return result;
}

export function mapScreenshotArguments(client: IDBClient, args: Record<string, unknown>): Record<string, unknown> {
  if (args.screenshotId === undefined) return args;
  const mapping = sessions.get(client)?.get(args.screenshotId as string);
  if (!mapping || mapping.expires < Date.now() || mapping.udid !== client.getConnectedDevice()) {
    throw new ToolError('Screenshot reference is unavailable, expired, or belongs to another device. Take a new screenshot and use its screenshotId.', { code: 'INVALID_SCREENSHOT_REFERENCE' });
  }
  const converted = { ...args };
  delete converted.screenshotId;
  for (const key of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
    if (args[key] === undefined) continue;
    const value = args[key] as number;
    const horizontal = key.startsWith('x');
    const limit = horizontal ? mapping.width : mapping.height;
    if (!Number.isFinite(value) || value < 0 || value >= limit) {
      throw new ToolError(`${key} is outside the referenced image. Use returned-image pixels within ${mapping.width}x${mapping.height}, not preview pixels.`, { code: 'IMAGE_COORDINATE_OUT_OF_BOUNDS' });
    }
    converted[key] = value * (horizontal ? mapping.x : mapping.y);
  }
  if (args.radius !== undefined) {
    // logical/pixel captures preserve isotropic screen scale. Radius is a length,
    // while pinch scale and duration must not be transformed.
    converted.radius = (args.radius as number) * mapping.x;
  }
  if (args.direction !== undefined) {
    const horizontal = args.direction === 'left' || args.direction === 'right';
    const distance = (args.distance ?? 200) as number;
    const start = args[horizontal ? 'x1' : 'y1'] as number;
    const end = start + (args.direction === 'left' || args.direction === 'up' ? -distance : distance);
    if (end < 0 || end >= (horizontal ? mapping.width : mapping.height)) {
      throw new ToolError('Scroll endpoint is outside the referenced image. Reduce distance or change the start point.', { code: 'IMAGE_COORDINATE_OUT_OF_BOUNDS' });
    }
    converted.distance = distance * (horizontal ? mapping.x : mapping.y);
  }
  return converted;
}
