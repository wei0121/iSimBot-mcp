#!/usr/bin/env node
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'node:path';
import { clearScreenshotCoordinates } from '../image/screenshot-coordinates.js';

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
}

export function parseDevices(stdout: string): Device[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = text.startsWith('[')
    ? JSON.parse(text)
    : text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (!Array.isArray(parsed)) throw new Error('Invalid device list');
  return parsed.map((device: any) => ({
    udid: device.udid, name: device.name, state: device.state,
    type: device.type || 'simulator',
  }));
}

export class IDBClient {
  private udid: string | null = null;
  private screenshotScales = new Map<string, { udid: string; scale: number }>();

  getConnectedDevice() { return this.udid; }

  getScreenshotGeometry(path: string) {
    const geometry = this.screenshotScales.get(resolve(path));
    this.screenshotScales.delete(resolve(path));
    return geometry;
  }

  async listDevices(): Promise<Device[]> {
    try {
      const { stdout } = await run('idb', ['list-targets', '--json']);
      return parseDevices(stdout);
    } catch (error) {
      throw new Error(`Failed to list devices: ${(error as Error).message}`);
    }
  }

  async connect(udid: string): Promise<void> {
    try {
      await run('idb', ['connect', '--', udid], { timeout: 30000 });
      clearScreenshotCoordinates(this);
      this.udid = udid;

      // Auto-reconnect HID for coordinate-based control
      await this.reconnectHID();
    } catch (error) {
      throw new Error(`Failed to connect to device ${udid}: ${(error as Error).message}`);
    }
  }

  async reconnectHID(): Promise<void> {
    if (!this.udid) {
      throw new Error('No device connected');
    }

    try {
      // Disconnect and reconnect HID to ensure clean state
      await run('idb', ['hid', 'disconnect', '--udid', this.udid], { timeout: 5000 }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 500));
      await run('idb', ['hid', 'connect', '--udid', this.udid], { timeout: 5000 });
    } catch (error) {
      // HID reconnect failure is not fatal - it will auto-retry on next operation
      console.error(`HID reconnect warning: ${(error as Error).message}`);
    }
  }

  private async sendTap(x: number, y: number, duration: number): Promise<void> {
    try {
      await run('idb', ['ui', 'tap', '--udid', this.udid!, '--duration', duration, '--', x, y], { timeout: 10000 });
    } catch (error) {
      throw new Error(`Failed to tap at (${x}, ${y}): ${(error as Error).message}`);
    }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.reconnectHID();
    await this.sendTap(x, y, 0.1);
  }

  async doubleTap(x: number, y: number): Promise<void> {
    // Reconnect once before the pair, not between the two taps.
    await this.reconnectHID();
    await this.sendTap(x, y, 0.1);
    await new Promise(resolve => setTimeout(resolve, 100));
    await this.sendTap(x, y, 0.1);
  }

  async longPress(x: number, y: number, duration: number = 1.0): Promise<void> {
    await this.reconnectHID();
    await this.sendTap(x, y, duration);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, duration: number = 0.5): Promise<void> {
    if (!this.udid) {
      throw new Error('No device connected. Call connect() first.');
    }

    await this.reconnectHID();

    try {
      await run('idb', ['ui', 'swipe', '--udid', this.udid, '--duration', duration, '--', x1, y1, x2, y2], { timeout: 10000 });
    } catch (error) {
      throw new Error(`Failed to swipe from (${x1}, ${y1}) to (${x2}, ${y2}): ${(error as Error).message}`);
    }
  }

  async scroll(x1: number, y1: number, direction: 'up' | 'down' | 'left' | 'right', distance: number = 200): Promise<void> {
    if (!this.udid) throw new Error('No device connected. Call connect() first.');
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
      throw new Error('No device connected. Call connect() first.');
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
      throw new Error('No device connected. Call connect() first.');
    }

    try {
      await run('idb', ['ui', 'text', '--udid', this.udid, '--', text], { timeout: 10000 });
    } catch (error) {
      throw new Error(`Failed to type text: ${(error as Error).message}`);
    }
  }

  async screenshot(outputPath?: string): Promise<string> {
    if (!this.udid) {
      throw new Error('No device connected. Call connect() first.');
    }

    const captureUdid = this.udid;
    const path = outputPath || `${process.env.TMPDIR || '/tmp'}/screenshot-${Date.now()}.png`;

    try {
      const { stdout } = await run('idb', ['screenshot', '--udid', captureUdid, '--json', '--', resolve(path)], { timeout: 10000 });
      this.screenshotScales.delete(resolve(path));
      try {
        const metadata = JSON.parse(stdout);
        if (typeof metadata.screen_scale === 'number' && Number.isFinite(metadata.screen_scale) && metadata.screen_scale > 0) {
          this.screenshotScales.set(resolve(path), { udid: captureUdid, scale: metadata.screen_scale });
          if (this.screenshotScales.size > 32) this.screenshotScales.delete(this.screenshotScales.keys().next().value!);
        }
      } catch { /* Older idb versions can return no metadata. Never guess scale. */ }
      return path;
    } catch (error) {
      throw new Error(`Failed to take screenshot: ${(error as Error).message}`);
    }
  }

  async describeUI(): Promise<string> {
    if (!this.udid) {
      throw new Error('No device connected. Call connect() first.');
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
      await run('xcrun', ['simctl', 'boot', safeIdentifier(udid)], { timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for boot
    } catch (error) {
      // Ignore if already booted
      if (!(error as any).message?.includes('Unable to boot device in current state: Booted')) {
        throw new Error(`Failed to boot simulator: ${(error as Error).message}`);
      }
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
      throw new Error('No device connected. Call connect() first.');
    }

    try {
      await run('idb', ['install', '--udid', this.udid, '--', resolve(appPath)], { timeout: 60000 });
    } catch (error) {
      throw new Error(`Failed to install app: ${(error as Error).message}`);
    }
  }

  async launchApp(bundleId: string): Promise<void> {
    if (!this.udid) {
      throw new Error('No device connected. Call connect() first.');
    }

    try {
      await run('idb', ['launch', '--udid', this.udid, safeIdentifier(bundleId)], { timeout: 10000 });
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for app to launch
    } catch (error) {
      throw new Error(`Failed to launch app ${bundleId}: ${(error as Error).message}`);
    }
  }

  async terminateApp(bundleId: string): Promise<void> {
    if (!this.udid) {
      throw new Error('No device connected. Call connect() first.');
    }

    try {
      await run('idb', ['terminate', '--udid', this.udid, '--', bundleId], { timeout: 10000 });
    } catch (error) {
      throw new Error(`Failed to terminate app ${bundleId}: ${(error as Error).message}`);
    }
  }

  async uninstallApp(bundleId: string): Promise<void> {
    if (!this.udid) {
      throw new Error('No device connected. Call connect() first.');
    }

    try {
      await run('idb', ['uninstall', '--udid', this.udid, '--', bundleId], { timeout: 30000 });
    } catch (error) {
      throw new Error(`Failed to uninstall app ${bundleId}: ${(error as Error).message}`);
    }
  }

  async setLocation(latitude: number, longitude: number): Promise<void> {
    if (!this.udid) {
      throw new Error('No device connected. Call connect() first.');
    }

    try {
      await run('idb', ['set-location', '--udid', this.udid, '--', latitude, longitude], { timeout: 5000 });
    } catch (error) {
      throw new Error(`Failed to set location: ${(error as Error).message}`);
    }
  }

  async getLogs(lines: number = 100): Promise<string> {
    if (!this.udid) {
      throw new Error('No device connected. Call connect() first.');
    }

    try {
      const { stdout } = await run('idb', ['log', '--udid', this.udid, '--', '--tail', lines], { timeout: 10000 });
      return stdout;
    } catch (error) {
      throw new Error(`Failed to get logs: ${(error as Error).message}`);
    }
  }

  async pinch(x: number, y: number, scale: number = 2.0, duration: number = 0.5): Promise<void> {
    if (!this.udid) {
      throw new Error('No device connected. Call connect() first.');
    }

    await this.reconnectHID();

    // Pinch is implemented as two-finger gesture
    // idb doesn't have native pinch, so we simulate with swipes
    const offset = 50;
    const x1 = x - offset, y1 = y - offset;
    const x2 = x + offset, y2 = y + offset;

    if (scale > 1) {
      // Pinch out (zoom in)
      await this.swipe(x, y, x1, y1, duration);
      await new Promise(resolve => setTimeout(resolve, 50));
      await this.swipe(x, y, x2, y2, duration);
    } else {
      // Pinch in (zoom out)
      await this.swipe(x1, y1, x, y, duration);
      await new Promise(resolve => setTimeout(resolve, 50));
      await this.swipe(x2, y2, x, y, duration);
    }
  }
}
