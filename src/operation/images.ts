import { dirname, join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { timelinePattern, withEventIndexes } from '../common/operation.js';
import { ObservationStore } from '../storage/observation-store.js';
import { ChainCaptureStore, chainDirectory } from '../storage/chain-captures.js';
import { readTimelineCapture, type StoredCapture } from '../storage/timeline-images.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';

export const imageTools: ToolDefinition[] = [{
  definition: { name: 'get_images', description: 'Read saved capture images by timeline and public event indexes, in request order. Supports archived observations and completed chains without connecting to a simulator. No new screenshots are taken. Up to 6 unique indexes, 6 images and 16 MB Base64 per response; individual missing/cleaned images report errors while other indexes continue. Captures in both mode may contain two images. No arbitrary file paths accepted.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['timeline', 'indexes'], properties: {
      timeline: { type: 'string' }, indexes: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { type: 'integer', minimum: 0 } },
    } } }, responseType: 'mcp',
  async execute(_client, args, settings): Promise<CallToolResult> {
    if (Object.keys(args).some(k => !['timeline', 'indexes'].includes(k)) || typeof args.timeline !== 'string' || !timelinePattern.test(args.timeline) || !Array.isArray(args.indexes) || !args.indexes.length || args.indexes.length > 6 || args.indexes.some(i => !Number.isSafeInteger(i) || i < 0) || new Set(args.indexes).size !== args.indexes.length) throw new Error('Provide timeline and 1–6 unique non-negative integer indexes.');
    const timeline = args.timeline, indexes = args.indexes as number[];
    let directory: string;
    let captures: Array<{ index: number; time: number; capture?: StoredCapture }>;
    if (timeline.startsWith('session_')) {
      directory = join(dirname(settings.path), 'observations');
      const saved = new ObservationStore(directory).lookup(timeline);
      if (!saved) throw new Error('Observation timeline not found.');
      if (saved.observing) throw new Error('Stop or get the observation before fetching images so event indexes are fixed.');
      captures = withEventIndexes(saved.session.events).filter(e => e.tool === 'capture');
    } else {
      directory = chainDirectory(settings);
      const saved = new ChainCaptureStore(directory).find(timeline);
      if (!saved) throw new Error('Chain capture timeline not found.');
      captures = saved.captures;
    }
    let bytes = 0, imageCount = 0;
    const content: CallToolResult['content'] = [];
    const events = indexes.map(index => {
      const entry = captures.find(e => e.index === index);
      try {
        if (!entry?.capture) throw new Error('This event has no saved capture images.');
        const images = readTimelineCapture(directory, entry.capture, timeline);
        const size = images.reduce((n, c) => n + (c.type === 'image' ? c.data.length : 0), 0);
        if (imageCount + images.length > 6 || bytes + size > 16_000_000) throw new Error('Image batch limit reached. Request fewer indexes.');
        imageCount += images.length; bytes += size;
        content.push({ type: 'text', text: `Event index ${index}: capture; time ${entry.time}` }, ...images);
        return { index, time: entry.time, success: true, images: entry.capture.images };
      } catch (error) { return { index, ...(entry ? { time: entry.time } : {}), success: false, error: (error as Error).message }; }
    });
    const success = events.every(e => e.success);
    const summary = { timeline, success, partial: !success && events.some(e => e.success), events };
    return { structuredContent: summary, ...(events.every(e => !e.success) ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(summary) }, ...content] };
  },
}];
