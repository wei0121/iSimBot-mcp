import { deviceOrientations } from './device-orientation.js';
import { ToolError } from '../mcp/tool-error.js';
import { validateArguments } from '../mcp/validate-arguments.js';
export const textSizes = ['extra-small', 'small', 'medium', 'large', 'extra-large', 'extra-extra-large', 'extra-extra-extra-large', 'accessibility-medium', 'accessibility-large', 'accessibility-extra-large', 'accessibility-extra-extra-large', 'accessibility-extra-extra-extra-large'] as const;
export type TextSize = typeof textSizes[number];
export const payloadProperties = {
  size: { type: 'string', enum: [...textSizes], description: 'Dynamic Type category for set_text_size.' },
  orientation: { type: 'string', enum: [...deviceOrientations], description: 'Absolute physical orientation for rotate.' },
  appearance: { type: 'string', enum: ['light', 'dark'], description: 'System appearance for set_appearance.' },
  bundleId: { type: 'string', description: 'Installed app bundle ID for notification actions.' },
  notification: { type: 'object', additionalProperties: true, description: 'APNs JSON object with an aps object, at most 4096 UTF-8 bytes. Only for send_notification.' },
  latitude: { type: 'number', minimum: -90, maximum: 90 },
  longitude: { type: 'number', minimum: -180, maximum: 180 },
  offset: { type: 'integer', minimum: 0, default: 0, description: 'list_notifications offset; live delivery order can change between calls.' },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 100, description: 'list_notifications page size.' },
};
const fields = {
  get_settings: [], set_text_size: ['size'], rotate: ['orientation'], set_appearance: ['appearance'],
  send_notification: ['bundleId', 'notification'], list_notifications: ['bundleId', 'offset', 'limit'], set_location: ['latitude', 'longitude'],
} as const;
export type DeviceControlAction = keyof typeof fields;
export const deviceControlActions = Object.keys(fields) as DeviceControlAction[];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parseDeviceControl(args: Record<string, unknown>): { action: DeviceControlAction; payload: Record<string, any> } {
  const action = args.action as DeviceControlAction;
  if (!deviceControlActions.includes(action)) throw new ToolError('Unknown device_control action.', { code: 'INVALID_DEVICE_CONTROL', actions: deviceControlActions });
  if (!object(args.payload)) throw new ToolError('payload must be an object; use {} for get_settings. deviceId belongs at arguments top level, not inside payload.', { code: 'INVALID_DEVICE_CONTROL' });
  const allowed = fields[action] as readonly string[];
  const schema = { type: 'object' as const, additionalProperties: false, properties: Object.fromEntries(allowed.map(k => [k, payloadProperties[k as keyof typeof payloadProperties]])), required: allowed.filter(k => k !== 'offset' && k !== 'limit') };
  validateArguments({ definition: { name: `device_control.${action}.payload`, inputSchema: schema } }, args.payload);
  if (args.payload.bundleId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(args.payload.bundleId as string)) throw new Error('Invalid notification bundleId.');
  if (action === 'send_notification') {
    const notification = args.payload.notification;
    if (!object(notification) || !object(notification.aps)) throw new Error('notification must contain an aps object.');
    // Reject values JSON would silently drop or alter; bound depth before serializing.
    const seen = new Set<object>();
    const visit = (v: unknown, depth = 0): void => {
      if (depth > 20) throw new Error('notification exceeds maximum JSON nesting (20).');
      if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' && Number.isFinite(v)) return;
      if (typeof v !== 'object' || seen.has(v)) throw new Error('notification must contain finite, acyclic JSON values.');
      seen.add(v); for (const item of Object.values(v)) visit(item, depth + 1); seen.delete(v);
    };
    visit(notification);
    const bytes = Buffer.byteLength(JSON.stringify(notification));
    if (bytes > 4096) throw new ToolError(`notification exceeds 4096 bytes (${bytes} UTF-8 bytes). No notification was sent.`, { code: 'NOTIFICATION_TOO_LARGE', actualBytes: bytes, maxBytes: 4096 });
  }
  return { action, payload: args.payload };
}
