import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { configPath, type Client } from '../setting/client-config.js';
const run = promisify(execFile);
export async function doctor(): Promise<boolean> {
  let healthy = true;
  console.log('isimbot doctor — read-only environment checks');
  console.log(`${process.platform === 'darwin' ? 'OK' : 'FAIL'} macOS`);
  if (process.platform !== 'darwin') healthy = false;
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOK = major > 20 || (major === 20 && minor >= 9);
  console.log(`${nodeOK ? 'OK' : 'FAIL'} Node.js ${process.versions.node}`);
  healthy &&= nodeOK;
  for (const [label, command, args] of [
    ['Xcode', 'xcodebuild', ['-version']],
    ['idb client', 'idb', ['--help']],
    ['idb companion', 'idb_companion', ['--version']],
    ['Simulator runtimes', 'xcrun', ['simctl', 'list', 'runtimes', '--json']],
  ] as const) {
    try {
      const { stdout } = await run(command, [...args], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      if (label === 'Simulator runtimes' && !JSON.parse(stdout).runtimes?.some((runtime: any) => runtime.isAvailable && runtime.identifier?.includes('.iOS-'))) throw new Error('No available iOS runtime');
      console.log(`OK ${label}`);
    } catch {
      healthy = false;
      console.log(`FAIL ${label}: missing, unavailable, or command failed`);
    }
  }
  const serverName = process.env.ISIMBOT_SERVER_NAME || 'isimbot';
  for (const client of ['claude', 'codex'] as Client[]) {
    const path = configPath(client);
    if (!existsSync(path)) { console.log(`INFO ${client}: not configured`); continue; }
    try {
      const source = readFileSync(path, 'utf8');
      const config = client === 'claude' ? JSON.parse(source) : parse(source);
      const servers = config?.[client === 'claude' ? 'mcpServers' : 'mcp_servers'];
      console.log(`INFO ${client}: ${servers?.[serverName] ? `${serverName} entry present` : `no ${serverName} entry`}`);
    } catch { healthy = false; console.log(`FAIL ${client}: configuration cannot be read or parsed (unchanged)`); }
  }
  console.log('Checks do not boot simulators or verify MCP connections / UI operations.');
  return healthy;
}
