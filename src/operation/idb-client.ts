import { textSizes, deviceControlActions, parseDeviceControl, type TextSize } from '../common/device-control.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDisplayGeometry, parseHIDRotation, hidPoint, type DisplayGeometry } from '../image/display-geometry.js';
import { validateOrientation, parseOrientation, type DeviceOrientation } from '../common/device-orientation.js';
import { ToolError } from '../mcp/tool-error.js';
import { appIsRunning, waitUntilRunning } from './readiness.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'node:path';
import { clearScreenshotCoordinates, beginCoordinateChange, endCoordinateChange } from '../image/screenshot-coordinates.js';

const execFileAsync = promisify(execFile);

// Never invoke a shell. Bound both execution time and captured output.
async function run(file: string, args: (string | number)[], options: { timeout?: number } = {}) {
  for (const arg of args) {
    if ((typeof arg !== 'string' && typeof arg !== 'number') ||
        (typeof arg === 'number' && !Number.isFinite(arg)) ||
        (typeof arg === 'string' && arg.includes('\0'))) throw new Error('Invalid command argument');
  }
  try {
    return await execFileAsync(file, args.map(String), { timeout: 10000, maxBuffer: 8 * 1024 * 1024, ...options });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    const reason = failure.code === 'ENOENT' ? `${file} was not found. Run isimbot doctor.`
      : failure.killed ? `${file} timed out. The operation may have completed; inspect the simulator before retrying.`
      : (failure.stderr?.trim().slice(-2000) || `${file} failed (${failure.code || 'unknown error'}).`);
    // Do not echo command arguments, which can contain text entered into the app.
    throw new Error(reason);
  }
}

function safeIdentifier(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('-') || value.includes('\0')) throw new Error('Invalid device or application identifier');
  return value;
}

export interface Device {
  udid: string;
  name: string;
  state: string;
  type: string;
  runtime: string | null;
  model: string | null;
}

export function parseDevices(stdout: string): Device[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = text.startsWith('[')
    ? JSON.parse(text)
    : text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (!Array.isArray(parsed)) throw new Error('Invalid device list');
  return parsed.filter(device => device && typeof device.udid === 'string' && device.udid.trim()).map((device: any) => ({
    udid: device.udid.trim(), name: device.name, state: device.state,
    type: device.type || 'simulator',
    runtime: typeof device.os_version === 'string' && device.os_version.trim() ? device.os_version.trim() : null,
    model: null,
  }));
}


// Resolve the actual simulator type by UDID, never by its user-editable name.
export function parseSimulatorModels(stdout: string): Map<string, string> {
  const inventory = JSON.parse(stdout);
  if (!inventory || !Array.isArray(inventory.devicetypes) || !inventory.devices || typeof inventory.devices !== 'object' || Array.isArray(inventory.devices)) throw new Error('Invalid simulator model inventory');
  const types = new Map<string, string>();
  for (const type of inventory.devicetypes) {
    if (type && typeof type.identifier === 'string' && typeof type.name === 'string' && type.name.trim()) types.set(type.identifier, type.name);
  }
  const models = new Map<string, string>();
  for (const group of Object.values(inventory.devices)) {
    if (!Array.isArray(group)) continue;
    for (const device of group) {
      const model = device && types.get(device.deviceTypeIdentifier);
      if (model && typeof device.udid === 'string') models.set(device.udid.toUpperCase(), model);
    }
  }
  return models;
}

export class IDBClient {
  private udid: string | null = null;
  private screenshotScales = new Map<string, { udid: string; scale: number; orientation?: number }>();

  private async displayGeometry(includeHID = false): Promise<(DisplayGeometry & { hidRotation?: number }) | undefined> {
    // Physical-device transport is unchanged; this reader runs only in a simulator.
    if (!this.udid || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(this.udid)) return;
    const helper = fileURLToPath(new URL('../native/isimbot-display', import.meta.url));
    if (!existsSync(helper)) throw new ToolError('Display reader missing. Rebuild the local native tools with ./scripts/local-npm run build:observation, or update the installed package. No coordinate guess was made.', { code: 'DISPLAY_GEOMETRY_UNAVAILABLE' });
    try {
      const { stdout } = await run('xcrun', ['simctl', 'spawn', this.udid, helper], { timeout: 5000 });
      const display = parseDisplayGeometry(stdout);
      if (!includeHID) return display;
      const hid = await run('xcrun', ['devicectl', 'device', 'info', 'displays', '--device', this.udid, '--json-output', '-'], { timeout: 5000 });
      return { ...display, hidRotation: parseHIDRotation(hid.stdout) };
    } catch (error) {
      throw new ToolError(`Cannot read current interface orientation: ${(error as Error).message}. Capture/touch coordinates were not guessed; inspect the simulator and retry.`, { code: 'DISPLAY_GEOMETRY_UNAVAILABLE' });
    }
  }

  getConnectedDevice() { return this.udid; }

  getScreenshotGeometry(path: string) {
    const geometry = this.screenshotScales.get(resolve(path));
    this.screenshotScales.delete(resolve(path));
    return geometry;
  }

  async listDevices(): Promise<Device[]> {
    try {
      const { stdout } = await run('idb', ['list-targets', '--json']);
      const devices = parseDevices(stdout);
      if (!devices.some(device => device.type === 'simulator')) return devices;
      try {
        const inventory = await run('xcrun', ['simctl', 'list', '--json']);
        const models = parseSimulatorModels(inventory.stdout);
        return devices.map(device => ({ ...device, model: device.type === 'simulator' ? models.get(device.udid.toUpperCase()) ?? null : null }));
      } catch {
        // Listing devices remains usable when CoreSimulator cannot supply models.
        return devices;
      }
    } catch (error) {
      throw new Error(`Failed to list devices: ${(error as Error).message}`);
    }
  }

  async connect(udid: string): Promise<void> {
    try {
      await run('idb', ['connect', '--', udid], { timeout: 30000 });
      clearScreenshotCoordinates(this);
      this.udid = udid;
    } catch (error) {
      throw new Error(`Failed to connect to device ${udid}: ${(error as Error).message}`);
    }
  }

  // idb tap/multi-tap/swipe parse coordinates as integers. Round only after
  // screenshot scaling and interface-to-display conversion, at the CLI boundary.
  private async sendTap(x: number, y: number, duration: number): Promise<void> {
    const point = hidPoint(x, y, await this.displayGeometry(true)).map(Math.round);
    try {
      await run('idb', ['ui', 'tap', '--udid', this.udid!, '--duration', duration, '--', ...point], { timeout: 10000 });
    } catch (error) {
      throw new Error(`Failed to tap at (${x}, ${y}): ${(error as Error).message}`);
    }
  }

  async tap(x: number, y: number): Promise<void> {
    if (!this.udid) throw new Error('No internal device connection. Retry the operation with deviceId.');
    await this.sendTap(x, y, 0.1);
  }

  async doubleTap(x: number, y: number): Promise<void> {
    if (!this.udid) throw new Error('No internal device connection. Retry the operation with deviceId.');
    const point = hidPoint(x, y, await this.displayGeometry(true)).map(Math.round);
    try {
      // One HID stream keeps the inter-tap pause on the companion; separate CLI
      // processes add startup/connection latency and can become two single taps.
      await run('idb', ['ui', 'multi-tap', '--udid', this.udid, '--count', 2,
        '--duration', 0.1, '--pause', 0.1, '--', ...point], { timeout: 10000 });
    } catch (error) {
      throw new Error(`Failed to double tap at (${x}, ${y}): ${(error as Error).message}`);
    }
  }

  async longPress(x: number, y: number, duration: number = 1.0): Promise<void> {
    if (!this.udid) throw new Error('No internal device connection. Retry the operation with deviceId.');
    await this.sendTap(x, y, duration);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, duration: number = 0.5): Promise<void> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    const display = await this.displayGeometry(true);
    const start = hidPoint(x1, y1, display).map(Math.round), end = hidPoint(x2, y2, display).map(Math.round);
    try {
      await run('idb', ['ui', 'swipe', '--udid', this.udid, '--duration', duration, '--', ...start, ...end], { timeout: 10000 });
    } catch (error) {
      throw new Error(`Failed to swipe from (${x1}, ${y1}) to (${x2}, ${y2}): ${(error as Error).message}`);
    }
  }

  async scroll(x1: number, y1: number, direction: 'up' | 'down' | 'left' | 'right', distance: number = 200): Promise<void> {
    if (!this.udid) throw new Error('No internal device connection. Retry the operation with deviceId.');
    let x2 = x1, y2 = y1;
    switch (direction) {
      case 'up': y2 -= distance; break;
      case 'down': y2 += distance; break;
      case 'left': x2 -= distance; break;
      case 'right': x2 += distance; break;
      default: throw new Error(`Unknown scroll direction: ${direction}`);
    }
    await this.swipe(x1, y1, x2, y2, 0.3);
  }

  async pressButton(button: 'home' | 'lock' | 'volumeUp' | 'volumeDown'): Promise<void> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    const buttonMap: Record<string, string> = {
      home: 'HOME',
      lock: 'LOCK',
      volumeUp: 'VOLUME_UP',
      volumeDown: 'VOLUME_DOWN'
    };

    const idbButton = buttonMap[button];
    if (!idbButton) {
      throw new Error(`Unknown button: ${button}`);
    }

    try {
      await run('idb', ['ui', 'button', '--udid', this.udid, '--', idbButton], { timeout: 5000 });
    } catch (error) {
      throw new Error(`Failed to press ${button}: ${(error as Error).message}`);
    }
  }

  async typeText(text: string): Promise<void> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    try {
      await run('idb', ['ui', 'text', '--udid', this.udid, '--', text], { timeout: 10000 });
    } catch (error) {
      throw new Error(`Failed to type text: ${(error as Error).message}`);
    }
  }

  async openUrl(url: string): Promise<void> {
    if (!this.udid) throw new Error('No internal device connection. Retry the operation with deviceId.');
    if (typeof url !== 'string' || /[\s\x00-\x1f\x7f]/.test(url)) throw new Error('Provide an absolute URL with a scheme; encode spaces and control characters.');
    try { new URL(url); } catch { throw new Error('Provide an absolute URL with a scheme, such as https://example.com or myapp://page.'); }
    try {
      await run('idb', ['open', '--udid', this.udid, '--', url]);
    } catch {
      throw new Error('Could not open URL on this device. Check the URL and that an installed app handles its scheme. A page may have opened; inspect with capture before retrying.');
    }
  }

  async listApps(): Promise<{ bundleId: string; name: string | null; installType: string | null; processState: string | null }[]> {
    if (!this.udid) throw new Error('No internal device connection. Retry the operation with deviceId.');
    const { stdout } = await run('idb', ['list-apps', '--udid', this.udid, '--json', '--fetch-process-state']);
    const text = stdout.trim();
    const apps = !text ? [] : text.startsWith('[') ? JSON.parse(text)
      : text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    if (!Array.isArray(apps) || apps.some(app => !app || typeof app.bundle_id !== 'string' || !app.bundle_id)) throw new Error('Invalid app list returned by idb');
    return apps.map(app => ({ bundleId: app.bundle_id,
      name: typeof app.name === 'string' ? app.name : null,
      installType: typeof app.install_type === 'string' ? app.install_type : null,
      processState: typeof app.process_state === 'string' ? app.process_state : null,
    }));
  }

  private requireDevice(): string {
    if (!this.udid) throw new Error('No internal device connection. Supply deviceId.');
    return safeIdentifier(this.udid);
  }

  async getDeviceAppearance(timeout = 10000): Promise<'light' | 'dark'> {
    const { stdout } = await run('xcrun', ['simctl', 'ui', this.requireDevice(), 'appearance'], { timeout });
    const value = stdout.trim();
    if (value !== 'light' && value !== 'dark') throw new Error(`Appearance unavailable: ${value.slice(0, 100) || 'empty response'}.`);
    return value;
  }

  async getDeviceTextSize(timeout = 10000): Promise<TextSize> {
    const { stdout } = await run('xcrun', ['simctl', 'ui', this.requireDevice(), 'content_size'], { timeout });
    const value = stdout.trim() as TextSize;
    if (!textSizes.includes(value)) throw new Error(`System text size unavailable: ${value.slice(0, 100) || 'empty response'}.`);
    return value;
  }

  async getPhysicalOrientation(): Promise<string> {
    return parseOrientation((await run('idb', ['rotation', '--udid', this.requireDevice(), '--json'])).stdout);
  }

  async getDeviceSettings() {
    this.requireDevice();
    const fields = ['appearance', 'textSize', 'orientation'] as const;
    const values = await Promise.allSettled([this.getDeviceAppearance(), this.getDeviceTextSize(), this.getPhysicalOrientation()]);
    const settings: Record<string, string | null> = {}, errors: Record<string, string> = {}, capabilities: Record<string, { readable: boolean }> = {};
    values.forEach((result, i) => {
      const field = fields[i]; capabilities[field] = { readable: result.status === 'fulfilled' };
      settings[field] = result.status === 'fulfilled' ? result.value : null;
      if (result.status === 'rejected') errors[field] = result.reason instanceof Error ? result.reason.message : String(result.reason);
    });
    return { settings, capabilities, actions: deviceControlActions, partial: Object.keys(errors).length > 0, ...(Object.keys(errors).length ? { errors } : {}) };
  }

  private async setUISetting(option: 'appearance' | 'content_size', requested: string, read: (remainingMs: number) => Promise<string>): Promise<string> {
    let actual: string | undefined;
    try {
      await run('xcrun', ['simctl', 'ui', this.requireDevice(), option, requested]);
      const deadline = performance.now() + 3000;
      do {
        actual = await read(Math.max(1, Math.ceil(deadline - performance.now())));
        if (actual === requested) return actual;
        if (performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - performance.now()))));
      } while (performance.now() < deadline);
    } catch (error) {
      throw new ToolError(`Could not confirm system ${option}: ${(error as Error).message}. The request may have applied; use device_control get_settings before retrying.`, {
        code: 'DEVICE_SETTING_FAILED', setting: option, requested, actual: actual ?? null,
      });
    }
    throw new ToolError(`System ${option} was not confirmed. The setting may have changed; inspect before retrying.`, { code: 'DEVICE_SETTING_NOT_CONFIRMED', requested, actual: actual ?? null });
  }

  async setDeviceAppearance(appearance: 'light' | 'dark'): Promise<'light' | 'dark'> {
    parseDeviceControl({ action: 'set_appearance', payload: { appearance } });
    return await this.setUISetting('appearance', appearance, (ms) => this.getDeviceAppearance(ms)) as 'light' | 'dark';
  }

  async setDeviceTextSize(size: TextSize): Promise<TextSize> {
    parseDeviceControl({ action: 'set_text_size', payload: { size } });
    return await this.setUISetting('content_size', size, (ms) => this.getDeviceTextSize(ms)) as TextSize;
  }

  async sendNotification(bundleId: string, notification: Record<string, unknown>): Promise<void> {
    parseDeviceControl({ action: 'send_notification', payload: { bundleId, notification } });
    await run('idb', ['notification', 'send', '--udid', this.requireDevice(), '--', bundleId, JSON.stringify(notification)]);
  }

  async listNotifications(bundleId: string) {
    parseDeviceControl({ action: 'list_notifications', payload: { bundleId } });
    const { stdout } = await run('idb', ['notification', 'list', '--udid', this.requireDevice(), '--json', '--', bundleId]);
    const text = stdout.trim();
    const records = !text ? [] : text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    if (!Array.isArray(records)) throw new Error('Invalid delivered notification list.');
    return records.map(item => {
      if (!item || item.bundle_id !== bundleId || typeof item.identifier !== 'string' ||
        !['title', 'subtitle', 'body', 'thread_identifier'].every(key => typeof item[key] === 'string') ||
        !(item.date === null || typeof item.date === 'number' && Number.isFinite(item.date))) throw new Error('Invalid delivered notification data.');
      return { bundleId: item.bundle_id, identifier: item.identifier, title: item.title, subtitle: item.subtitle, body: item.body, threadIdentifier: item.thread_identifier, deliveredAt: item.date };
    }).sort((a, b) => (b.deliveredAt ?? -Infinity) - (a.deliveredAt ?? -Infinity) || a.identifier.localeCompare(b.identifier));
  }

  async rotate(orientation: DeviceOrientation): Promise<void> {
    validateOrientation(orientation);
    if (!this.udid) throw new Error('No internal device connection. Retry rotate with deviceId.');
    await this.displayGeometry();
    beginCoordinateChange(this);
    let actual: string | undefined;
    try {
      await run('idb', ['rotation', '--udid', this.udid, '--', orientation.toUpperCase()], { timeout: 10000 });
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
        const { stdout } = await run('idb', ['rotation', '--udid', this.udid, '--json'], { timeout: remaining });
        actual = parseOrientation(stdout);
        if (actual === orientation) return;
        const wait = Math.min(100, Math.max(0, deadline - performance.now()));
        if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      }
      throw new ToolError('Requested physical orientation was not confirmed within 5 seconds. Inspect the simulator before retrying; no automatic rotation retry was performed.', {
        code: 'ROTATION_NOT_CONFIRMED', requestedOrientation: orientation, actualOrientation: actual ?? null,
      });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(`Rotation could not be confirmed: ${(error as Error).message}. Requires idb client/companion with rotation support (project runtime 1.7.8). Inspect device state before retrying; no GUI or app-injection fallback was used.`, {
        code: 'ROTATION_FAILED', requestedOrientation: orientation, actualOrientation: actual ?? null,
      });
    } finally { endCoordinateChange(this); }
  }

  async screenshot(outputPath?: string): Promise<string> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    const captureUdid = this.udid;
    const path = outputPath || `${process.env.TMPDIR || '/tmp'}/screenshot-${Date.now()}.png`;

    try {
      const display = await this.displayGeometry();
      const { stdout } = await run('idb', ['screenshot', '--udid', captureUdid, '--json', '--', resolve(path)], { timeout: 10000 });
      this.screenshotScales.delete(resolve(path));
      if (display) {
        const after = await this.displayGeometry();
        if (JSON.stringify(after) !== JSON.stringify(display)) throw new ToolError('Interface changed during screenshot. Take a fresh capture after rotation settles.', { code: 'DISPLAY_CHANGED_DURING_CAPTURE' });
      }
      try {
        const metadata = JSON.parse(stdout);
        if (typeof metadata.screen_scale === 'number' && Number.isFinite(metadata.screen_scale) && metadata.screen_scale > 0) {
          this.screenshotScales.set(resolve(path), { udid: captureUdid, scale: metadata.screen_scale, ...(display ? { orientation: display.orientation } : {}) });
          if (this.screenshotScales.size > 32) this.screenshotScales.delete(this.screenshotScales.keys().next().value!);
        }
      } catch { /* Older idb versions can return no metadata. Never guess scale. */ }
      return path;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new Error(`Failed to take screenshot: ${(error as Error).message}`);
    }
  }

  async describeUI(): Promise<string> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    try {
      const { stdout } = await run('idb', ['ui', 'describe-all', '--udid', this.udid], { timeout: 10000 });
      return stdout;
    } catch (error) {
      throw new Error(`Failed to describe UI: ${(error as Error).message}`);
    }
  }

  async bootSimulator(udid: string): Promise<void> {
    try {
      // simctl monitors actual boot progress, including already-booted devices.
      await run('xcrun', ['simctl', 'bootstatus', safeIdentifier(udid), '-b'], { timeout: 120000 });
    } catch (error) {
      throw new Error(`Failed to boot simulator: ${(error as Error).message}`);
    }
  }

  async shutdownSimulator(udid: string): Promise<void> {
    try {
      await run('xcrun', ['simctl', 'shutdown', safeIdentifier(udid)], { timeout: 30000 });
    } catch (error) {
      throw new Error(`Failed to shutdown simulator: ${(error as Error).message}`);
    }
  }

  async installApp(appPath: string): Promise<void> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    try {
      await run('idb', ['install', '--udid', this.udid, '--', resolve(appPath)], { timeout: 60000 });
    } catch (error) {
      throw new Error(`Failed to install app: ${(error as Error).message}`);
    }
  }

  async launchApp(bundleId: string): Promise<void> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    try {
      await run('idb', ['launch', '--udid', this.udid, '--foreground-if-running', safeIdentifier(bundleId)], { timeout: 10000 });
      await waitUntilRunning(async remainingMs => {
        const { stdout } = await run('idb', ['list-apps', '--udid', this.udid!, '--json', '--fetch-process-state'], { timeout: remainingMs });
        return appIsRunning(stdout, bundleId);
      });
    } catch (error) {
      throw new Error(`Failed to launch app ${bundleId}: ${(error as Error).message}`);
    }
  }

  async terminateApp(bundleId: string): Promise<void> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    try {
      await run('idb', ['terminate', '--udid', this.udid, '--', bundleId], { timeout: 10000 });
    } catch (error) {
      throw new Error(`Failed to terminate app ${bundleId}: ${(error as Error).message}`);
    }
  }

  async uninstallApp(bundleId: string): Promise<void> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    try {
      await run('idb', ['uninstall', '--udid', this.udid, '--', bundleId], { timeout: 30000 });
    } catch (error) {
      throw new Error(`Failed to uninstall app ${bundleId}: ${(error as Error).message}`);
    }
  }

  async setLocation(latitude: number, longitude: number): Promise<void> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    try {
      await run('idb', ['set-location', '--udid', this.udid, '--', latitude, longitude], { timeout: 5000 });
    } catch (error) {
      throw new Error(`Failed to set location: ${(error as Error).message}`);
    }
  }

  async getLogs(lines: number = 100): Promise<string> {
    if (!this.udid) {
      throw new Error('No internal device connection. Retry the operation with deviceId.');
    }

    try {
      const { stdout } = await run('idb', ['log', '--udid', this.udid, '--', '--tail', lines], { timeout: 10000 });
      return stdout;
    } catch (error) {
      throw new Error(`Failed to get logs: ${(error as Error).message}`);
    }
  }

  async pinch(x: number, y: number, scale = 2, duration = 0.5, radius = 100): Promise<void> {
    if (!this.udid) throw new Error('No internal device connection. Retry the operation with deviceId.');
    if (![x, y, scale, duration, radius].every(Number.isFinite) || x < 0 || y < 0 ||
        scale < 0.01 || scale > 100 || duration < 0.01 || duration > 5 || radius <= 0 || radius > 10000) {
      throw new Error('Invalid pinch: nonnegative coordinates, scale 0.01–100, duration 0.01–5 seconds, and radius >0–10000 points required.');
    }
    const point = hidPoint(x, y, await this.displayGeometry(true));
    try {
      // Native HIDPinch: simultaneous contacts, never sequential swipes.
      await run('idb', ['ui', 'pinch', '--udid', this.udid, '--duration', duration,
        '--radius', radius, '--', ...point, scale], { timeout: 10000 });
    } catch (error) {
      throw new Error(`Native pinch failed: ${(error as Error).message}. Requires an idb client/companion with native ui pinch support (project runtime: 1.7.8). No swipe fallback or automatic retry was performed.`);
    }
  }

}
