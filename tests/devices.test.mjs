import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDevices } from '../dist/operation/idb-client.js';
test('device list accepts real idb JSON lines, legacy arrays, single and empty outputs', () => {
  const a = { udid: 'a', name: 'Phone', state: 'Booted', type: 'simulator' };
  const b = { udid: 'b', name: 'Tablet', state: 'Shutdown', type: 'simulator' };
  assert.deepEqual(parseDevices(JSON.stringify(a) + '\n' + JSON.stringify(b) + '\n'), [a, b]);
  assert.deepEqual(parseDevices(JSON.stringify([a, b])), [a, b]);
  assert.deepEqual(parseDevices(JSON.stringify(a)), [a]);
  assert.deepEqual(parseDevices('  '), []);
  assert.throws(() => parseDevices('invalid'));
});
