import { mkdirSync, lstatSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface StoredCapture {
  images: { path: string; mimeType: 'image/png' | 'image/jpeg'; sizeBytes: number; timestamp?: number }[];
  metadata?: CallToolResult['structuredContent'];
}
function imageDirectory(directory: string, create = false) {
  const path = join(directory, 'images');
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error('Timeline directory must not be a symbolic link.');
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error('Timeline images directory must not be a symbolic link.');
  return path;
}
function checkedPath(directory: string, path: string, timeline?: string) {
  const root = imageDirectory(directory);
  const name = path.slice(root.length + 1);
  if ((timeline !== undefined && !name.startsWith(`${timeline}-capture-`)) || path !== join(root, name) || !/^(session|chain)_[0-9a-f]{8}-capture-\d{6}-\d+\.(png|jpeg)$/.test(name)) throw new Error('Invalid timeline image reference.');
  return path;
}
export function saveTimelineCapture(directory: string, timeline: string, index: number, result: CallToolResult): StoredCapture {
  if (!/^(session|chain)_[0-9a-f]{8}$/.test(timeline) || !Number.isInteger(index) || index < 0 || index > 999999) throw new Error('Invalid timeline capture identity.');
  const capture: StoredCapture = { images: [], metadata: result.structuredContent };
  try {
    for (const image of result.content.filter(c => c.type === 'image')) {
      if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') throw new Error('Unsupported timeline image format.');
      const path = join(imageDirectory(directory, true), `${timeline}-capture-${String(index).padStart(6, '0')}-${capture.images.length}.${image.mimeType.slice(6)}`);
      const data = Buffer.from(image.data, 'base64');
      if (capture.images.length >= 2 || data.length > 5_000_000) throw new Error('Capture must contain at most two images, each at most 5 MB.');
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
      capture.images.push({ path, mimeType: image.mimeType, sizeBytes: data.length, ...(typeof result.structuredContent?.timestamp === 'number' ? { timestamp: result.structuredContent.timestamp } : {}) });
    }
    if (!capture.images.length) throw new Error('Timeline capture returned no image.');
    return capture;
  } catch (error) { deleteTimelineCapture(directory, capture); throw error; }
}
export function readTimelineCapture(directory: string, capture: StoredCapture, timeline?: string): CallToolResult['content'] {
  if (!Array.isArray(capture.images) || !capture.images.length || capture.images.length > 2) throw new Error('A saved capture must contain one or two images.');
  return capture.images.map(image => {
    if (!['image/png', 'image/jpeg'].includes(image.mimeType)) throw new Error('Unsupported timeline image format.');
    const path = checkedPath(directory, image.path, timeline);
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 5_000_000) throw new Error('Timeline image must be a regular file of at most 5 MB.');
    return { type: 'image', mimeType: image.mimeType, data: readFileSync(path).toString('base64') };
  });
}
export function deleteTimelineCapture(directory: string, capture: StoredCapture) {
  for (const image of capture.images) rmSync(checkedPath(directory, image.path), { force: true });
}
