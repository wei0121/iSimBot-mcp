import { IDBClient } from './idb-client.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import type { ScreenshotSettingsStore } from '../setting/screenshot-settings.js';
import { ToolError } from '../mcp/tool-error.js';
import { clearScreenshotCoordinates, screenshotDevice } from '../image/screenshot-coordinates.js';

const lifecycle = new Set(['connect_device', 'boot_simulator', 'shutdown_simulator']);
const globalTools = new Set(['list_devices', 'setup']);

// Routing parameters belong to the MCP boundary, not individual device operations.
export function deviceToolDefinition(tool: ToolDefinition) {
  const definition = structuredClone(tool.definition);
  if (globalTools.has(definition.name)) return definition;
  definition.inputSchema.properties = { ...definition.inputSchema.properties,
    deviceId: { type: 'string', description: 'Device UDID. Optional only with one connected device or a valid screenshotId. Chains bind one device for their entire duration.' },
  };
  if (lifecycle.has(definition.name)) {
    definition.inputSchema.required = [];
    definition.inputSchema.anyOf = [{ required: ['deviceId'] }, { required: ['udid'] }];
    definition.description += ' Supply deviceId (or legacy udid); both must agree if provided.';
  }
  return definition;
}

export class DeviceManager {
  private clients = new Map<string, IDBClient>();
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly discovery: IDBClient = new IDBClient(),
    private readonly createClient: () => IDBClient = () => new IDBClient()) {
    const deviceId = discovery.getConnectedDevice();
    if (deviceId) this.clients.set(this.identifier(deviceId), discovery);
  }

  private identifier(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-') || value.includes('\0')) {
      throw new ToolError('deviceId must be a non-empty device UDID.', { code: 'INVALID_DEVICE_ID' });
    }
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value.toUpperCase() : value;
  }

  private referenceDevice(value: unknown): string {
    if (typeof value === 'string') {
      for (const [id, client] of this.clients) {
        const referenced = screenshotDevice(client, value);
        if (referenced && this.identifier(referenced) === id) return id;
      }
    }
    throw new ToolError('Screenshot reference is invalid or expired. Take a new screenshot on the intended device.', { code: 'INVALID_SCREENSHOT_REFERENCE' });
  }

  private select(args: Record<string, unknown>): string {
    const targets = new Set<string>();
    if (args.deviceId !== undefined) targets.add(this.identifier(args.deviceId));
    if (args.screenshotId !== undefined) targets.add(this.referenceDevice(args.screenshotId));
    // Resolve existing references before a chain starts, so a cross-device step
    // cannot fail only after earlier steps have already changed the UI.
    if (Array.isArray(args.steps)) for (const step of args.steps) {
      if (step && typeof step === 'object' && step.arguments?.screenshotId !== undefined) {
        targets.add(this.referenceDevice(step.arguments.screenshotId));
      }
    }
    if (targets.size > 1) throw new ToolError('deviceId and screenshot references must identify the same device.', { code: 'DEVICE_MISMATCH' });
    if (targets.size === 1) return [...targets][0];
    if (this.clients.size === 1) return this.clients.keys().next().value!;
    throw new ToolError(this.clients.size ? 'Multiple devices connected. Supply deviceId or screenshotId.' : 'No device connected. Call connect_device with deviceId first.',
      { code: this.clients.size ? 'DEVICE_REQUIRED' : 'NO_DEVICE_CONNECTED', connectedDevices: [...this.clients.keys()] });
  }

  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) || Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => {}, () => {});
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return result;
  }

  async execute(tool: ToolDefinition, args: Record<string, unknown>, settings: ScreenshotSettingsStore): Promise<unknown> {
    const name = tool.definition.name;
    if (globalTools.has(name)) {
      const result = await tool.execute(this.discovery, args, settings);
      if (name === 'list_devices') return (result as Array<{ udid: string }>).map(device => ({ ...device, connected: this.clients.has(this.identifier(device.udid)) }));
      return result;
    }
    if (lifecycle.has(name)) {
      const id = this.identifier(args.deviceId !== undefined ? args.deviceId : args.udid);
      if (args.udid !== undefined && this.identifier(args.udid) !== id) throw new ToolError('udid and deviceId disagree.', { code: 'DEVICE_MISMATCH' });
      const { deviceId, ...parameters } = args;
      parameters.udid = id;
      return this.enqueue(id, async () => {
        const client = this.clients.get(id) || this.createClient();
        const result = await tool.execute(client, parameters, settings);
        if (name === 'connect_device') this.clients.set(id, client);
        if (name === 'shutdown_simulator') {
          clearScreenshotCoordinates(client);
          this.clients.delete(id);
        }
        return result;
      });
    }
    const id = this.select(args);
    const { deviceId, ...parameters } = args;
    return this.enqueue(id, async () => {
      const client = this.clients.get(id);
      if (!client) throw new ToolError(`Device ${id} is not connected. Call connect_device first.`, { code: 'DEVICE_NOT_CONNECTED', deviceId: id });
      // Recheck references after waiting: reconnect/shutdown may invalidate them.
      this.select({ ...parameters, deviceId: id });
      return tool.execute(client, parameters, settings);
    });
  }
}
