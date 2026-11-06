import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScreenshotSettingsStore } from '../dist/setting/screenshot-settings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
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
    assert.equal(listed.length, 33);
    for(const [name,key] of [['launch_app','enableTextInput'],['list_apps','installType'],['operation_chain','elementDetail'],['get_observation','elementDetail']]) assert.ok(listed.find(t=>t.name===name).inputSchema.properties[key],`${name}.${key} must be published`);
    for (const name of ['start_observation', 'stop_observation', 'get_observation', 'open_url', 'list_apps', 'start_recording', 'stop_recording', 'recording_status']) {
      assert.equal(listed.find(t => t.name === name).inputSchema.properties.deviceId.type, 'string');
    }
    assert.deepEqual(sorted(listed.filter(t => !['device_control', 'get_images', 'start_observation', 'stop_observation', 'get_observation', 'setup', 'screenshot', 'capture', 'operation_chain', 'open_url', 'list_apps', 'start_recording', 'stop_recording', 'recording_status'].includes(t.name))), sorted(baseline.filter(t => !['screenshot', 'capture'].includes(t.name))));
  } finally { await client.close(); }
});

test('MCP dispatch reaches all 20 non-image handlers with shared client and retains errors', async () => {
  const calls = [];
  const fake = new Proxy({}, { get: (_, method) => method === 'getConnectedDevice' ? () => 'device' : async (...args) => {
    calls.push([method, args]);
    if (method === 'connect' && args[0] === 'fail') throw new Error('connection failed');
    return ['listDevices', 'listApps'].includes(method) ? [] : method==='describeUI' ? '[]' : 'sample';
  } });
  const directory=mkdtempSync(join(tmpdir(),'isimbot-dispatch-'));
  const server = createServer(fake, new ScreenshotSettingsStore(join(directory,'screenshot.json')), () => fake);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const cases = [
      ['list_devices', {}, 'listDevices', []],
      ['boot_simulator', { udid: 'device' }, 'bootSimulator', ['device']],
      ['tap', { x: 1, y: 2 }, 'tap', [1, 2]],
      ['double_tap', { x: 1, y: 2 }, 'doubleTap', [1, 2]],
      ['long_press', { x: 1, y: 2 }, 'longPress', [1, 2, undefined]],
      ['swipe', { x1: 1, y1: 2, x2: 3, y2: 4 }, 'swipe', [1, 2, 3, 4, undefined]],
      ['scroll', { x1: 100, y1: 300, direction: 'up' }, 'scroll', [100, 300, 'up', undefined]],
      ['pinch', { x: 200, y: 400 }, 'pinch', [200, 400, 2, 0.5, 100]],
      ['press_button', { button: 'home' }, 'pressButton', ['home']],
      ['type_text', { text: 'hello' }, 'typeText', ['hello']],
      ['list_apps', {}, 'listApps', []],
      ['open_url', { url: 'myapp://page' }, 'openUrl', ['myapp://page']],
      ['install_app', { appPath: '/app' }, 'installApp', ['/app']],
      ...['launch', 'terminate', 'uninstall'].map(verb => [`${verb}_app`, { bundleId: 'app.id' }, `${verb}App`, ['app.id']]),
      
      ['describe_ui', {}, 'describeUI', []],
      ['get_logs', {}, 'getLogs', [undefined,undefined,undefined]],
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
    assert.equal(calls.length, 20);
    for (const [name, args, message] of [['missing', {}, 'Unknown tool: missing'], ['connect_device', { udid: 'fail' }, 'Unknown tool: connect_device']]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.deepEqual(JSON.parse(result.content[0].text), { success: false, error: message });
    }
  } finally { await client.close(); await server.close(); rmSync(directory,{recursive:true,force:true}); }
});
