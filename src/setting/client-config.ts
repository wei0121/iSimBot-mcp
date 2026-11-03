import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parse, stringify } from 'smol-toml';

export type Client = 'claude' | 'codex';
export function configPath(client: Client): string {
  return client === 'claude'
    ? join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')
    : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
}
function object(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Pure transformation: malformed input and occupied names never produce a write.
export function addServer(client: Client, source: string, command: string, args: string[], name = 'isimbot'): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid MCP server name');
  const config = source.trim() ? (client === 'claude' ? JSON.parse(source) : parse(source)) : {};
  if (!object(config)) throw new Error('Configuration must be an object.');
  const key = client === 'claude' ? 'mcpServers' : 'mcp_servers';
  if (config[key] !== undefined && !object(config[key])) throw new Error(`Invalid ${key}; configuration left unchanged.`);
  const servers = config[key] || {};
  if (Object.hasOwn(servers, name)) {
    const current = servers[name];
    if (object(current) && current.command === command && JSON.stringify(current.args || []) === JSON.stringify(args)) return null;
    throw new Error(`An ${name} entry already exists with different settings. It will not be overwritten.`);
  }
  const entry = { command, args };
  if (client === 'claude') {
    config[key] = { ...servers, [name]: { type: 'stdio', ...entry } };
    return JSON.stringify(config, null, 2) + '\n';
  }
  const result = source + '\n' + stringify({ mcp_servers: { [name]: entry } });
  parse(result); // Also rejects inline/closed TOML tables that cannot be extended.
  return result;
}

export function installConfig(client: Client, path: string, command: string, args: string[], name = 'isimbot'): string | null {
  const existed = existsSync(path);
  if (existed && !lstatSync(path).isFile()) throw new Error('Configuration must be a regular file; symbolic links are not modified.');
  const source = existed ? readFileSync(path, 'utf8') : '';
  const result = addServer(client, source, command, args, name);
  if (result === null) return null;
  mkdirSync(dirname(path), { recursive: true });
  const backup = existed ? `${path}.isimbot-${randomUUID()}.bak` : null;
  const temp = `${path}.isimbot-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, result, { flag: 'wx', mode: 0o600 });
    if (existsSync(path) !== existed || (existed && readFileSync(path, 'utf8') !== source)) throw new Error('Configuration changed during setup. Retry after closing the client.');
    if (backup) writeFileSync(backup, source, { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return backup || '';
}

export async function setup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run isimbot setup in an interactive terminal.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const name = process.env.ISIMBOT_SERVER_NAME || 'isimbot';
    console.log(`Configure ${name} for this user:\n  1. Claude Code\n  2. Codex\n  0. Cancel`);
    const choice = (await rl.question('Select client [1/2/0]: ')).trim();
    if (choice === '0' || choice === '') return;
    if (choice !== '1' && choice !== '2') throw new Error('Invalid selection; no configuration changed.');
    const client: Client = choice === '1' ? 'claude' : 'codex';
    const path = configPath(client);
    const command = process.env.ISIMBOT_LAUNCHER || process.execPath;
    const args = process.env.ISIMBOT_LAUNCHER ? [] : [resolve(process.argv[1])];
    console.log(`Configuration: ${path}\nMCP name: ${name}\nCommand: ${command}\nArguments: ${JSON.stringify(args)}`);
    console.log(`Existing entries are preserved. A different ${name} entry will not be replaced.`);
    const answer = (await rl.question('Add this configuration? [y/N]: ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') return;
    const backup = installConfig(client, path, command, args, name);
    console.log(backup === null ? `${name} is already configured; no changes made.` : `${name} configuration added.`);
    if (backup) console.log(`Backup: ${backup}`);
    console.log('Restart the client and check its MCP tools. Run isimbot doctor to check local dependencies.');
  } finally { rl.close(); }
}
