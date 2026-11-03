import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../dist/mcp/server.js';
const baseline = JSON.parse(readFileSync(new URL('./fixtures/tools.json', import.meta.url)));
const sorted = tools => [...tools].sort((a, b) => a.name.localeCompare(b.name));

test('stdio entry point publishes the expected tool schemas', async () => {
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], stderr: 'pipe' }));
    const listed = (await client.listTools()).tools;
    assert.equal(listed.length, 22);
    assert.deepEqual(sorted(listed.filter(t => !['setup', 'screenshot', 'operation_chain'].includes(t.name))), sorted(baseline.filter(t => t.name !== 'screenshot')));
  } finally { await client.close(); }
});

test('MCP dispatch reaches all 19 non-image handlers with shared client and retains errors', async () => {
  const calls = [];
  const fake = new Proxy({}, { get: (_, method) => method === 'getConnectedDevice' ? () => 'device' : async (...args) => {
    calls.push([method, args]);
    if (method === 'connect' && args[0] === 'fail') throw new Error('connection failed');
    return method === 'listDevices' ? [] : 'sample';
  } });
  const server = createServer(fake, undefined, () => fake);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const cases = [
      ['list_devices', {}, 'listDevices', []],
      ['connect_device', { udid: 'device' }, 'connect', ['device']],
      ['boot_simulator', { udid: 'device' }, 'bootSimulator', ['device']],
      ['tap', { x: 1, y: 2 }, 'tap', [1, 2]],
      ['double_tap', { x: 1, y: 2 }, 'doubleTap', [1, 2]],
      ['long_press', { x: 1, y: 2 }, 'longPress', [1, 2, undefined]],
      ['swipe', { x1: 1, y1: 2, x2: 3, y2: 4 }, 'swipe', [1, 2, 3, 4, undefined]],
      ['scroll', { x1: 100, y1: 300, direction: 'up' }, 'scroll', [100, 300, 'up', undefined]],
      ['pinch', { x: 1, y: 2 }, 'pinch', [1, 2, undefined, undefined]],
      ['press_button', { button: 'home' }, 'pressButton', ['home']],
      ['type_text', { text: 'hello' }, 'typeText', ['hello']],
      ['install_app', { appPath: '/app' }, 'installApp', ['/app']],
      ...['launch', 'terminate', 'uninstall'].map(verb => [`${verb}_app`, { bundleId: 'app.id' }, `${verb}App`, ['app.id']]),
      
      ['describe_ui', {}, 'describeUI', []],
      ['get_logs', {}, 'getLogs', [undefined]],
      ['set_location', { latitude: 1, longitude: 2 }, 'setLocation', [1, 2]],
      ['shutdown_simulator', { udid: 'device' }, 'shutdownSimulator', ['device']],
    ];
    for (const [name, args, method, expected] of cases) {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, name);
      assert.deepEqual(calls.at(-1), [method, expected], name);
      const value = JSON.parse(result.content[0].text);
      if (name === 'list_devices') assert.deepEqual(value, []);
      else assert.equal(value.success, true, name);
    }
    assert.equal(calls.length, 19);
    for (const [name, args, message] of [['missing', {}, 'Unknown tool: missing'], ['connect_device', { udid: 'fail' }, 'connection failed']]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.deepEqual(JSON.parse(result.content[0].text), { success: false, error: message });
    }
  } finally { await client.close(); await server.close(); }
});
