import { RecordingFile } from '../storage/recording-file.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IDBClient } from './idb-client.js';
import type { ToolDefinition } from '../mcp/tool-definition.js';

export type StopReason = 'requested' | 'max_duration' | 'chain_failed' | 'server_shutdown' | 'device_shutdown';
type State = 'starting' | 'recording' | 'stopping' | 'saved' | 'failed';
export class ScreenRecording {
  private child?: ChildProcess;
  private state: State = 'starting';
  private started = 0;
  private ended = 0;
  private finalizing = false;
  private reason?: StopReason;
  private error?: string;
  private limitTimer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private done!: Promise<ReturnType<ScreenRecording['status']>>;
  private readonly id = randomUUID();
  readonly path: string;
  private readonly file: RecordingFile;
  private recoveryPath?: string;
  private readonly command: string;
  private readonly startupTimeout: number;
  private readonly stopTimeout: number;
  constructor(private readonly udid: string, directory: string, private readonly maxDuration: number,
    options: { path?: string; command?: string; startupTimeout?: number; stopTimeout?: number } = {}) {
    this.command = options.command ?? 'xcrun';
    this.startupTimeout = options.startupTimeout ?? 15000;
    this.stopTimeout = options.stopTimeout ?? 15000;
    this.file = new RecordingFile(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${this.id}.mp4`, options.path);
    this.path = this.file.path;
  }
  get active() { return ['starting', 'recording', 'stopping'].includes(this.state); }
  status() {
    const sizeBytes = this.file.sizeBytes;
    return {
      success: this.state !== 'failed', recordingId: this.id, deviceId: this.udid,
      status: this.state, recording: this.state === 'recording', path: this.path,
      durationSeconds: this.started ? Math.round(((this.ended || performance.now()) - this.started) / 10) / 100 : 0,
      ...(this.recoveryPath ? { recoveryPath: this.recoveryPath } : {}),
      sizeBytes, maxDuration: this.maxDuration,
      ...(this.reason ? { stopReason: this.reason } : {}),
      ...(this.error ? { error: this.error, code: 'RECORDING_FAILED' } : {}),
    };
  }
  async start() {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let stderr = '';
    this.done = new Promise(resolve => {
      const child = this.child = spawn(this.command, ['simctl', 'io', this.udid, 'recordVideo', '--codec=h264', this.file.temporaryPath], { stdio: ['ignore', 'ignore', 'pipe'] });
      const startupTimer = setTimeout(() => {
        this.error = 'Recorder did not report its first frame before the startup timeout.';
        void this.stop('requested');
      }, this.startupTimeout);
      child.stderr!.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-4000);
        if (this.state === 'starting' && stderr.includes('Recording started')) {
          clearTimeout(startupTimer);
          this.state = 'recording'; this.started = performance.now();
          this.limitTimer = setTimeout(() => { void this.stop('max_duration'); }, this.maxDuration * 1000);
          ready();
        }
      });
      child.on('error', error => { this.error = `Could not run recorder: ${error.message}`; });
      child.on('close', async (code, signal) => {
        this.finalizing = true;
        clearTimeout(startupTimer); clearTimeout(this.limitTimer); clearTimeout(this.killTimer);
        this.ended ||= performance.now();
        if (!this.started || !this.reason || (code !== 0 && signal !== 'SIGINT')) {
          this.error ||= `Recorder exited unexpectedly (${code ?? signal}). ${stderr.trim()}`;
        }
        this.state = 'stopping';
        try { await this.file.finalize(); } catch {
          this.error = 'Could not move the video to its recording directory. The temporary file is preserved at recoveryPath.';
          this.recoveryPath = this.file.temporaryPath;
        }
        this.state = this.error ? 'failed' : 'saved';
        if (!this.status().sizeBytes) { this.error ||= 'Recorder produced no video file.'; this.state = 'failed'; }
        resolve(this.status()); ready();
      });
    });
    await started;
    const result = this.status();
    if (result.status !== 'recording') return { ...result, success: false };
    return result;
  }
  async stop(reason: StopReason = 'requested') {
    if (this.active && !this.reason && !this.finalizing) {
      this.reason = reason; this.ended = performance.now(); this.state = 'stopping';
      clearTimeout(this.limitTimer);
      this.child?.kill('SIGINT');
      this.killTimer = setTimeout(() => {
        this.error = 'Recorder did not finalize before the stop timeout. The file may be incomplete.';
        this.child?.kill('SIGKILL');
      }, this.stopTimeout);
    }
    return this.done ? await this.done : this.status();
  }
}

const recordings = new WeakMap<IDBClient, ScreenRecording>();
export function currentRecording(client: IDBClient) { return recordings.get(client); }
export async function stopClientRecording(client: IDBClient, reason: StopReason) {
  const recording = recordings.get(client);
  return recording?.active ? await recording.stop(reason) : undefined;
}
export const recordingTools: ToolDefinition[] = [
  {
    definition: {
      name: 'start_recording',
      description: 'Start background screen recording at native resolution (H.264 MP4). Returns after the first frame; other operations can continue. One recording per device. Files are saved to optional path, or the recordings directory under the current configuration directory. Records to a temporary file first, then transfers it; existing destinations are not overwritten. Video is not returned as MCP images. Default auto-stop: 300 seconds. Recordings are not automatically deleted.',
      inputSchema: { type: 'object', properties: {
        path: { type: 'string', description: 'Optional absolute .mp4 output file path on the MCP host. Parent directories are created. Existing destinations are rejected. Omit for an automatically named file in the default recordings directory.' },
        maxDuration: { type: 'number', minimum: 1, maximum: 3600, default: 300, description: 'Automatically stop after this many seconds (1–3600, default 300).' },
      } },
    },
    async execute(client, args, settings) {
      if (recordings.get(client)?.active) throw new Error('This device already has an active recording. Use recording_status or stop_recording first.');
      const udid = client.getConnectedDevice();
      if (!udid) throw new Error('Select a device before recording.');
      const recording = new ScreenRecording(udid, join(dirname(settings.path), 'recordings'), (args.maxDuration as number | undefined) ?? 300, { path: args.path as string | undefined });
      recordings.set(client, recording);
      return recording.start();
    },
  },
  {
    definition: { name: 'stop_recording', description: 'Stop recording and wait for the local MP4 file to finalize. Returns path, size and elapsed recording time (not decoded media duration). If already stopped, returns the last recording result for this server session.', inputSchema: { type: 'object', properties: {} } },
    async execute(client) {
      const recording = recordings.get(client);
      if (!recording) throw new Error('No recording exists for this device in this server session. Call start_recording first.');
      return recording.stop();
    },
  },
  {
    definition: { name: 'recording_status', description: 'Get the active or last recording status for this device in this server session, including auto-stop results and errors. The video path is local to the MCP host; it is usable after status is saved.', inputSchema: { type: 'object', properties: {} } },
    async execute(client) { return recordings.get(client)?.status() ?? { success: true, recording: false, status: 'idle' }; },
  },
];
