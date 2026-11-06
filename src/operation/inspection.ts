import type { ToolDefinition } from '../mcp/tool-definition.js';
import { parseElements } from './accessibility-elements.js';
import { compactElement } from '../mcp/element-presentation.js';
import { uiSnapshot } from '../storage/ui-snapshots.js';
import { ToolError } from '../mcp/tool-error.js';

export const inspectionTools: ToolDefinition[] = [
  {
    definition: {
      name: 'describe_ui',
      description: 'Inspect accessibility without an image. Saves the full raw tree to a local JSON file, returns a compact paginated element list by default (50, max 200). detail:number returns count; detail:raw explicitly returns the original JSON tree (max 256 KiB). Use returned snapshotId with offset/limit to read the SAME saved snapshot without querying the simulator again. Snapshots retain the latest 200 and clean removes them. Empty/missing AX elements do not prove the screen is empty. capture returns image and raw elements instead.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        snapshotId: { type: 'string', description: 'Saved snapshotId returned by this tool; omit for a fresh read.' },
        detail: { type: 'string', enum: ['number', 'list', 'raw'], default: 'list' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      } },
    },
    async execute(client, args, settings) {
      const saved = uiSnapshot(settings, args.snapshotId ? undefined : await client.describeUI(), args.snapshotId as string | undefined);
      const elements = parseElements(JSON.stringify(saved.tree)), detail = args.detail ?? 'list';
      const base = { success: true, snapshotId: saved.snapshotId, path: saved.path, elementCount: elements.length, detail };
      if (detail === 'number') return base;
      if (detail === 'raw') {
        if (Buffer.byteLength(JSON.stringify(saved.tree)) > 256 * 1024) throw new ToolError('Raw tree exceeds 256 KiB. Read the saved snapshot using detail:list and pagination.', { code: 'UI_TREE_TOO_LARGE', snapshotId: saved.snapshotId, path: saved.path });
        return { ...base, uiTree: saved.tree };
      }
      const offset = args.offset as number ?? 0, limit = args.limit as number ?? 50;
      return { ...base, offset, nextOffset: offset + limit < elements.length ? offset + limit : null, elements: elements.slice(offset, offset + limit).map(compactElement) };
    },
  },
  {
    definition: {
      name: 'get_logs',
      description: 'Read historical iOS Simulator unified logs (system and app OSLog/NSLog entries retained by the OS), not MCP server logs, Observe events or guaranteed stdout/stderr. Bounded one-shot read, not log streaming. Defaults to the last 30 seconds and at most 100 output lines. Filter by executable process name or PID, not bundle ID. Empty results do not prove no app activity.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        lines: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
        lastSeconds: { type: 'integer', minimum: 1, maximum: 300, default: 30 },
        process: { type: 'string', description: 'Executable process name or PID.' },
      } },
    },
    async execute(client, args) {
      const logs = await client.getLogs(args.lines as number | undefined, args.lastSeconds as number | undefined, args.process as string | undefined);
      return { success: true, source: 'simulator_unified_log', lastSeconds: args.lastSeconds ?? 30, logs };
    },
  },
];
