import { setObservationScheduler, stopClientObservation } from './observation.js';
import { stopClientRecording } from './recording.js';
import { randomBytes } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { IDBClient } from './idb-client.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';
import type { ScreenshotSettingsStore } from '../setting/screenshot-settings.js';
import { ToolError } from '../mcp/tool-error.js';
import { clearScreenshotCoordinates, screenshotDevice } from '../image/screenshot-coordinates.js';

const lifecycle = new Set(['boot_simulator', 'shutdown_simulator']);
const globalTools = new Set(['list_devices', 'setup']);

// Routing parameters belong to the MCP boundary, not individual device operations.
export function deviceToolDefinition(tool: ToolDefinition) {
  const definition = structuredClone(tool.definition);
  if (globalTools.has(definition.name)) return definition;
  definition.inputSchema.properties = { ...definition.inputSchema.properties,
    deviceId: { type: 'string', description: 'Short deviceId, full udid, or exact unique device name from list_devices. MCP connects automatically. Can be omitted with a valid screenshotId or a single previously used device. Chains bind one device for their entire duration.' },
  };
  if (lifecycle.has(definition.name)) {
    definition.inputSchema.required = [];
    // Some MCP clients reject root-level combinators. Keep alias requirements
    // in the description and enforce them in execute() before backend calls.
    definition.inputSchema.properties.deviceId = { type: 'string', description: 'Short deviceId, full UDID, or exact unique device name. Required unless legacy udid is supplied.' };
    definition.description += ' Supply deviceId (or legacy udid); both must agree if provided.';
  }
  return definition;
}

export class DeviceManager {
  private aliases = new Map<string, string>();
  private deviceIds = new Map<string, string>();

  private shortId(udid: string): string {
    const existing = this.deviceIds.get(udid);
    if (existing) return existing;
    let id: string;
    do { id = randomBytes(4).toString('hex'); } while (this.aliases.has(id));
    this.aliases.set(id, udid);
    this.deviceIds.set(udid, id);
    return id;
  }

  private exposeDeviceInfo(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const value = data as Record<string, any>;
    if (value.recordingId && typeof value.deviceId === 'string') {
      const udid = this.identifier(value.deviceId);
      value.deviceId = this.shortId(udid); value.udid = udid;
    }
    if (value.recordingCleanup) this.exposeDeviceInfo(value.recordingCleanup);
    if (value.recording) this.exposeDeviceInfo(value.recording);
    if (value.deviceInfo && typeof value.deviceInfo.deviceId === 'string') {
      const udid = this.identifier(value.deviceInfo.deviceId);
      value.deviceInfo = { ...value.deviceInfo, deviceId: this.shortId(udid), udid };
    }
    if (Array.isArray(value.images)) value.images.forEach((entry: unknown) => this.exposeDeviceInfo(entry));
    if (Array.isArray(value.steps)) value.steps.forEach((step: any) => this.exposeDeviceInfo(step.result));
  }

  private clients = new Map<string, IDBClient>();
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly discovery: IDBClient = new IDBClient(),
    private readonly createClient: () => IDBClient = () => new IDBClient()) {
    const deviceId = discovery.getConnectedDevice();
    if (deviceId) this.clients.set(this.identifier(deviceId), discovery);
  }

  private identifier(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-') || value.includes('\0')) {
      throw new ToolError('deviceId must be a non-empty short ID or UDID.', { code: 'INVALID_DEVICE_ID' });
    }
    const udid = this.aliases.get(value);
    if (udid) return udid;
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value.toUpperCase() : value;
  }

  private async resolveTarget(value: unknown): Promise<string> {
    const id = this.identifier(value);
    if (this.aliases.has(value as string) || this.clients.has(id) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return id;
    const devices = await this.discovery.listDevices();
    // IDs take precedence over names, including non-UUID physical device IDs.
    const byId = devices.find(device => this.identifier(device.udid) === id);
    if (byId) return this.identifier(byId.udid);
    const matches = devices.filter(device => device.name === value);
    if (matches.length === 1) return this.identifier(matches[0].udid);
    if (matches.length > 1) throw new ToolError(`Multiple devices are named "${value}". Use a short deviceId or full UDID.`, {
      code: 'AMBIGUOUS_DEVICE_NAME', devices: matches.map(device => ({ ...device, deviceId: this.shortId(this.identifier(device.udid)) })),
    });
    throw new ToolError(`Unknown device "${value}". Call list_devices for a current short ID, full UDID or exact name.`, {
      code: /^[a-z0-9]{8}$/.test(id) ? 'UNKNOWN_DEVICE_ID' : 'DEVICE_NOT_FOUND', deviceId: value,
    });
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
    throw new ToolError('Supply deviceId from list_devices (or a valid screenshotId). MCP connects automatically.', { code: 'DEVICE_REQUIRED' });
  }

  private enqueue<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('MCP server is shutting down.'));
    const previous = this.queues.get(id) || Promise.resolve();
    const result = previous.then(action);
    const tail = result.then(() => {}, () => {});
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return result;
  }

  private closing = false;
  private closed?: Promise<void>;
  close(): Promise<void> {
    this.closing = true;
    return this.closed ??= (async () => {
      await Promise.allSettled([...this.queues.values()]);
      await Promise.allSettled([...this.clients.values()].map(async client => {
        await stopClientObservation(client);
        const result = await stopClientRecording(client, 'server_shutdown');
        if (result && !result.success) console.error('Recording shutdown failed:', JSON.stringify(result));
      }));
    })();
  }

  async execute(tool: ToolDefinition, args: Record<string, unknown>, settings: ScreenshotSettingsStore): Promise<unknown> {
    if (this.closing) throw new Error('MCP server is shutting down.');
    const name = tool.definition.name;
    if (globalTools.has(name)) {
      const result = await tool.execute(this.discovery, args, settings);
      if (name === 'list_devices') return (result as Array<{ udid: string }>).map(device => ({
        ...device, deviceId: this.shortId(this.identifier(device.udid)),
      }));
      return result;
    }
    if (args.deviceId !== undefined) args = { ...args, deviceId: await this.resolveTarget(args.deviceId) };
    if (lifecycle.has(name)) {
      const id = this.identifier(args.deviceId !== undefined ? args.deviceId : args.udid);
      if (args.udid !== undefined && this.identifier(args.udid) !== id) throw new ToolError('udid and deviceId disagree.', { code: 'DEVICE_MISMATCH' });
      const { deviceId, ...parameters } = args;
      parameters.udid = id;
      return this.enqueue(id, async () => {
        const client = this.clients.get(id) || this.createClient();
        if (name === 'shutdown_simulator') await stopClientObservation(client);
        const result = await tool.execute(client, parameters, settings);
        this.exposeDeviceInfo(result);
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
      let client = this.clients.get(id);
      if (!client) {
        const device = (await this.discovery.listDevices()).find(d => this.identifier(d.udid) === id);
        if (!device) throw new ToolError(`Device ${id} was not found. Call list_devices for available IDs.`, { code: 'DEVICE_NOT_FOUND', deviceId: id });
        if (device.type.toLowerCase() === 'simulator' && device.state.toLowerCase() !== 'booted') {
          throw new ToolError(`Simulator ${id} is ${device.state}. Call boot_simulator with this deviceId first.`, { code: 'DEVICE_NOT_BOOTED', deviceId: id });
        }
        client = this.createClient();
        try { await client.connect(id); }
        catch (error) {
          throw new ToolError(`Could not automatically connect to ${id}: ${(error as Error).message}. Check that the device is available and run isimbot doctor.`, { code: 'DEVICE_CONNECTION_FAILED', deviceId: id });
        }
        this.clients.set(id, client);
        setObservationScheduler(client, task => this.closing ? Promise.resolve() : this.enqueue(id, task));
      }
      // Recheck references after waiting: reconnect/shutdown may invalidate them.
      this.select({ ...parameters, deviceId: id });
      const result = await tool.execute(client, parameters, settings);
      this.exposeDeviceInfo(tool.responseType === 'mcp' ? (result as CallToolResult).structuredContent : result);
      if (name === 'operation_chain') {
        const text = (result as CallToolResult).content[0];
        if (text?.type === 'text') {
          const summary = JSON.parse(text.text);
          this.exposeDeviceInfo(summary);
          text.text = JSON.stringify(summary, null, 2);
        }
      }
      return result;
    });
  }
}
