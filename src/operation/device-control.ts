import { deviceControlActions, payloadProperties, parseDeviceControl, type TextSize } from '../common/device-control.js';
import type { DeviceOrientation } from '../common/device-orientation.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
export const deviceControlTools: ToolDefinition[] = [{
  definition: {
    name: 'device_control',
    description: 'Control simulator settings with action and action-specific payload. deviceId is the common TOP-LEVEL routing field, never inside payload; operation_chain supplies it at chain level. Actions: get_settings payload {}; set_text_size {size}; rotate {orientation}; set_appearance {appearance:light|dark}; send_notification {bundleId,notification:{aps:{...}}}; list_notifications {bundleId,offset?,limit?}; set_location {latitude,longitude}. Unknown or unrelated payload fields fail preflight. get_settings reads appearance/textSize/physical orientation independently, reporting unsupported fields and errors rather than guessed values. Font/appearance changes affect apps that honor those system settings; physical rotation does not force a locked interface or wait for animation. Notification send simulates delivery, not end-to-end APNs; list reads currently retained delivered notifications, not history or a live stream. Location is a fixed coordinate only; acceptance does not prove an app received an update. Supports operation_chain; no app builds, clipboard or new dependencies.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action', 'payload'], properties: {
      action: { type: 'string', enum: deviceControlActions },
      payload: { type: 'object', additionalProperties: false, properties: payloadProperties, description: 'Only fields for the selected action. Empty object for get_settings. deviceId is never placed here.' },
    } },
  },
  validate(args) { parseDeviceControl(args); },
  async execute(client, args) {
    const { action, payload } = parseDeviceControl(args);
    switch (action) {
      case 'get_settings': return { success: true, action, ...await client.getDeviceSettings() };
      case 'set_text_size': {
        const size = await client.setDeviceTextSize(payload.size as TextSize);
        return { success: true, action, size, confirmed: true, message: 'System Dynamic Type setting confirmed; app layout depends on Dynamic Type support. Use capture to inspect.' };
      }
      case 'set_appearance': {
        const appearance = await client.setDeviceAppearance(payload.appearance as 'light' | 'dark');
        return { success: true, action, appearance, confirmed: true, message: 'System appearance confirmed; an app can override it. Use capture to inspect.' };
      }
      case 'rotate':
        await client.rotate(payload.orientation as DeviceOrientation);
        return { success: true, action, orientation: payload.orientation, confirmed: true, message: 'Physical orientation confirmed. App interface may be locked or animating; take a fresh capture.' };
      case 'set_location':
        await client.setLocation(payload.latitude, payload.longitude);
        return { success: true, action, latitude: payload.latitude, longitude: payload.longitude, accepted: true, message: 'Fixed simulated location requested. App delivery depends on location permission and active location requests; no route or movement is simulated.' };
      case 'send_notification':
        await client.sendNotification(payload.bundleId, payload.notification);
        return { success: true, action, bundleId: payload.bundleId, accepted: true, message: 'Simulated notification delivery requested; banner/display depends on app permission and foreground handling. Verify with list_notifications or capture.' };
      case 'list_notifications': {
        const all = await client.listNotifications(payload.bundleId);
        const offset = payload.offset ?? 0, limit = payload.limit ?? 100;
        const notifications = all.slice(offset, offset + limit);
        return { success: true, action, bundleId: payload.bundleId, total: all.length, offset, nextOffset: offset + notifications.length < all.length ? offset + notifications.length : null, notifications };
      }
    }
  },
}];
