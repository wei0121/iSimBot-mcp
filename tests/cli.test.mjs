import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { addServer, installConfig } from '../dist/setting/client-config.js';
import { parse } from 'smol-toml';

for (const client of ['claude', 'codex']) {
  test(`${client}: preserve unrelated settings and refuse conflicts`, () => {
    const source = client === 'claude' ? '{"theme":"dark","mcpServers":{"other":{"command":"other"}}}' : '# keep this comment\ntheme = "dark"\n[mcp_servers.other]\ncommand = "other"\n';
    const output = addServer(client, source, '/node', ['/installed/index.js']);
    const parsed = client === 'claude' ? JSON.parse(output) : parse(output);
    assert.equal(parsed.theme, 'dark');
    assert.equal(parsed[client === 'claude' ? 'mcpServers' : 'mcp_servers'].other.command, 'other');
    if (client === 'codex') assert.ok(output.startsWith(source));
    assert.equal(addServer(client, output, '/node', ['/installed/index.js']), null);
    assert.throws(() => addServer(client, output, '/different', []), /not be overwritten/);
    assert.throws(() => addServer(client, 'not valid config {', '/node', []));
  });
  test(`${client}: backup originals and leave malformed files untouched`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'isimbot-test-'));
    try {
      const path = join(dir, 'config');
      const source = client === 'claude' ? '{"keep":42}' : '# comment\nkeep = 42\n';
      writeFileSync(path, source);
      const backup = installConfig(client, path, '/node', ['/app']);
      assert.equal(readFileSync(backup, 'utf8'), source);
      const installed = readFileSync(path, 'utf8');
      assert.equal(installConfig(client, path, '/node', ['/app']), null);
      assert.equal(readFileSync(path, 'utf8'), installed);
      writeFileSync(path, 'broken {');
      assert.throws(() => installConfig(client, path, '/node', []));
      assert.equal(readFileSync(path, 'utf8'), 'broken {');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
test('CLI handles help, version, removed commands and noninteractive setup', () => {
  const run = (...args) => spawnSync(process.execPath, ['dist/index.js', ...args], { encoding: 'utf8' });
  assert.match(run('--help').stdout, /isimbot doctor/);
  assert.equal(run('--version').stdout.trim(), JSON.parse(readFileSync('package.json')).version);
  for (const command of ['clear', 'status', 'unknown']) assert.equal(run(command).status, 1);
  const setup = run('setup');
  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /interactive terminal/);
});
