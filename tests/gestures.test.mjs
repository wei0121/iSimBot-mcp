import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBClient } from '../dist/operation/idb-client.js';
import { gesturesTools } from '../dist/operation/gestures.js';

test('scroll starts exactly at supplied point and moves in all four directions', async () => {
  const client = new IDBClient();
  client.udid = 'test';
  const calls = [];
  client.swipe = async (...args) => calls.push(args);
  for (const direction of ['up', 'down', 'left', 'right']) await client.scroll(300, 400, direction);
  assert.deepEqual(calls, [
    [300, 400, 300, 200, 0.3], [300, 400, 300, 600, 0.3],
    [300, 400, 100, 400, 0.3], [300, 400, 500, 400, 0.3],
  ]);
  await client.scroll(100, 300, 'up', 50);
  assert.deepEqual(calls.at(-1), [100, 300, 100, 250, 0.3]);
});
test('single/double taps use fixed presses; long press preserves duration and default', async () => {
  const client = new IDBClient();
  const calls = [];
  client.reconnectHID = async () => calls.push('connect');
  client.sendTap = async (...args) => calls.push(args);
  await client.tap(1, 2);
  assert.deepEqual(calls.splice(0), ['connect', [1, 2, 0.1]]);
  await client.doubleTap(3, 4);
  assert.deepEqual(calls.splice(0), ['connect', [3, 4, 0.1], [3, 4, 0.1]]);
  await client.longPress(5, 6);
  await client.longPress(5, 6, 2);
  assert.deepEqual(calls, ['connect', [5, 6, 1], 'connect', [5, 6, 2]]);
});
test('gesture calls reject obsolete parameters and missing scroll coordinates before executing', async () => {
  const tap = gesturesTools.find(t => t.definition.name === 'tap');
  const scroll = gesturesTools.find(t => t.definition.name === 'scroll');
  await assert.rejects(tap.execute({}, { x: 1, y: 2, duration: 1 }, {}), /duration/);
  await assert.rejects(scroll.execute({}, { direction: 'up' }, {}), /x1/);
});
