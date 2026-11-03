import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOperationChain } from '../dist/operation/operation-chain.js';
import { deviceTools } from '../dist/operation/device.js';
import { gesturesTools } from '../dist/operation/gestures.js';
import { createServer } from '../dist/mcp/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function fixture() {
  const events = [];
  let pictures = 0;
  const screenshot = {
    definition: { name: 'screenshot', inputSchema: { type: 'object', properties: {} } },
    responseType: 'mcp',
    execute: async () => {
      events.push('screenshot'); pictures++;
      return { content: [{ type: 'image', mimeType: 'image/png', data: `image-${pictures}` }] };
    },
  };
  const chain = createOperationChain([...gesturesTools, ...deviceTools, screenshot], async ms => { events.push(`wait:${ms}`); });
  const client = { tap: async (...args) => events.push(['tap', ...args]) };
  return { events, chain, client };
}
test('screenshots and waits are sequential and all images are returned with step labels', async () => {
  const { chain, client, events } = fixture();
  const result = await chain.execute(client, { steps: [
    { tool: 'screenshot' },
    { tool: 'tap', arguments: { x: 10, y: 20 }, delay: 0.3 },
    { tool: 'screenshot', delay: 0.3 },
  ] }, {});
  assert.deepEqual(events, ['wait:300', 'screenshot', 'wait:300', ['tap', 10, 20], 'wait:300', 'screenshot']);
  assert.deepEqual(result.content.filter(item => item.type === 'image').map(item => item.data), ['image-1', 'image-2']);
  assert.match(result.content[1].text, /Step 1: screenshot/);
  assert.match(result.content[3].text, /Step 3: screenshot/);
  const summary = JSON.parse(result.content[0].text);
  assert.equal(summary.success, true);
  assert.equal(summary.steps.length, 3);
});
test('preflight rejects invalid late steps before any action', async () => {
  for (const bad of [
    { tool: 'operation_chain' }, { tool: 'setup' },
    { tool: 'tap', arguments: { x: 1 } },
    { tool: 'tap', arguments: { x: '1', y: 2 } },
    { tool: 'screenshot', delay: -1 },
    { tool: 'screenshot', delay: 11 },
    { tool: 'screenshot', arguments: { unexpected: 1 } },
  ]) {
    const { chain, client, events } = fixture();
    await assert.rejects(chain.execute(client, { steps: [{ tool: 'screenshot' }, bad] }, {}));
    assert.deepEqual(events, []);
  }
  const { chain, client } = fixture();
  await assert.rejects(chain.execute(client, { steps: Array(7).fill({ tool: 'screenshot' }) }, {}), /6 screenshots/);
  await assert.rejects(chain.execute(client, { steps: Array(4).fill({ tool: 'screenshot', delay: 10 }) }, {}), /30 seconds/);
});
test('failure stops subsequent steps and retains earlier images and outcomes', async () => {
  const { chain, events } = fixture();
  const result = await chain.execute({ tap: async () => { throw new Error('tap failed'); } }, { steps: [
    { tool: 'screenshot' }, { tool: 'tap', arguments: { x: 1, y: 2 } }, { tool: 'screenshot' },
  ] }, {});
  assert.equal(result.isError, true);
  const summary = JSON.parse(result.content[0].text);
  assert.equal(summary.skippedSteps, 1);
  assert.equal(summary.steps[1].error, 'tap failed');
  assert.equal(result.content.filter(item => item.type === 'image').length, 1);
  assert.deepEqual(events, ['wait:300', 'screenshot', 'wait:300']);
});
test('operation_chain is callable over MCP and shares the device client', async () => {
  const calls = [];
  const server = createServer({ getConnectedDevice: () => 'device', tap: async (x, y) => calls.push([x, y]) });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const result = await client.callTool({ name: 'operation_chain', arguments: { steps: [
      { tool: 'tap', arguments: { x: 10, y: 20 } },
    ] } });
    assert.equal(JSON.parse(result.content[0].text).success, true);
    assert.deepEqual(calls, [[10, 20]]);
  } finally { await client.close(); await server.close(); }
});

test('each delay waits after the previous async operation completes, not from chain start', async () => {
  let clock = 0;
  const starts = [];
  const tool = {
    definition: { name: 'slow', inputSchema: { type: 'object', properties: {} } },
    execute: async () => {
      starts.push(clock);
      await Promise.resolve();
      clock += 2000;
      return { success: true };
    },
  };
  const chain = createOperationChain([tool], async ms => { clock += ms; });
  await chain.execute({}, { steps: [
    { tool: 'slow', delay: 0.1 },
    { tool: 'slow' },
    { tool: 'slow', delay: 0 },
  ] }, {});
  assert.deepEqual(starts, [100, 2400, 4400]);
});
