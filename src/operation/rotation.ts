import { deviceOrientations, type DeviceOrientation } from '../common/device-orientation.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';

export const rotationTools: ToolDefinition[] = [{
  definition: {
    name: 'rotate',
    description: 'Set the simulator physical device orientation to an absolute direction and poll readback (up to 5s). portrait is upright; landscape_left/right name device orientation (top of device left/right), not relative turns. The app may lock its interface orientation or still be animating; confirmation is physical orientation, not UI readiness. Use capture afterward. Invalidates previous screenshot coordinate references, including images captured during rotation; take a fresh image before tapping. Works in operation_chain. Requires native idb rotation support; no app injection or GUI permissions.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['orientation'], properties: {
      orientation: { type: 'string', enum: [...deviceOrientations], description: 'Absolute physical orientation: portrait, portrait_upside_down, landscape_left, or landscape_right.' },
    } },
  },
  async execute(client, args) {
    const orientation = args.orientation as DeviceOrientation;
    await client.rotate(orientation);
    return { success: true, orientation, message: 'Physical device orientation confirmed. App interface rotation depends on app support and may still be animating. Take a fresh capture before using coordinates.' };
  },
}];
