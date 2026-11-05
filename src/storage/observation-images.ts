import { mkdirSync, lstatSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface StoredCapture {
  images: { path: string; mimeType: 'image/png' | 'image/jpeg'; sizeBytes: number }[];
  metadata?: CallToolResult['structuredContent'];
}
function imageDirectory(directory: string) {
  const path = join(directory, 'images');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error('Observation images directory must not be a symbolic link.');
  return path;
}
function checkedPath(directory: string, path: string) {
  const root = imageDirectory(directory);
  const name = path.slice(root.length + 1);
  if (path !== join(root, name) || !/^session_[0-9a-f]{8}-capture-\d{6}-\d+\.(png|jpeg)$/.test(name)) throw new Error('Invalid observation image reference.');
  return path;
}
export function saveObservationCapture(directory: string, timeline: string, index: number, result: CallToolResult): StoredCapture {
  if (!/^session_[0-9a-f]{8}$/.test(timeline) || !Number.isInteger(index) || index < 0 || index > 999999) throw new Error('Invalid observation capture identity.');
  const capture: StoredCapture = { images: [], metadata: result.structuredContent };
  try {
    for (const image of result.content.filter(c => c.type === 'image')) {
      if (image.mimeType !== 'image/png' && image.mimeType !== 'image/jpeg') throw new Error('Unsupported observation image format.');
      const path = join(imageDirectory(directory), `${timeline}-capture-${String(index).padStart(6, '0')}-${capture.images.length}.${image.mimeType.slice(6)}`);
      const data = Buffer.from(image.data, 'base64');
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
      capture.images.push({ path, mimeType: image.mimeType, sizeBytes: data.length });
    }
    if (!capture.images.length) throw new Error('Observation capture returned no image.');
    return capture;
  } catch (error) { deleteObservationCapture(directory, capture); throw error; }
}
export function readObservationCapture(directory: string, capture: StoredCapture): CallToolResult['content'] {
  return capture.images.map(image => {
    const path = checkedPath(directory, image.path);
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 5_000_000) throw new Error('Observation image must be a regular file of at most 5 MB.');
    return { type: 'image', mimeType: image.mimeType, data: readFileSync(path).toString('base64') };
  });
}
export function deleteObservationCapture(directory: string, capture: StoredCapture) {
  for (const image of capture.images) rmSync(checkedPath(directory, image.path), { force: true });
}
