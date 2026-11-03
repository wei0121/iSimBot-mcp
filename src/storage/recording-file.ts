import { mkdirSync, mkdtempSync, statSync, lstatSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute, extname } from 'node:path';

/** simctl's video writer cannot write to some external volumes. Finalize locally first. */
export class RecordingFile {
  readonly temporaryPath: string;
  readonly path: string;
  private readonly temporaryDirectory: string;
  private moved = false;
  constructor(directory: string, filename: string, outputPath?: string) {
    if (outputPath !== undefined && (typeof outputPath !== 'string' || outputPath.includes('\0') || !isAbsolute(outputPath) || extname(outputPath).toLowerCase() !== '.mp4')) {
      throw new Error('Recording path must be an absolute .mp4 file path on the MCP host.');
    }
    this.path = outputPath ?? join(directory, filename);
    try {
      lstatSync(this.path);
      throw new Error('Recording destination already exists. Choose a new path; existing files are never overwritten.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.temporaryDirectory = mkdtempSync(join(tmpdir(), 'isimbot-recording-'));
    this.temporaryPath = join(this.temporaryDirectory, filename);
  }
  get sizeBytes() {
    try { return statSync(this.moved ? this.path : this.temporaryPath).size; } catch { return 0; }
  }
  async finalize() {
    if (this.sizeBytes) {
      // Exclusive creation also protects a destination created during recording.
      await copyFile(this.temporaryPath, this.path, constants.COPYFILE_EXCL);
      this.moved = true;
    }
    await rm(this.temporaryDirectory, { recursive: true, force: true });
  }
}
