import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import ports from '../electron/ports.cjs';

test('Electron port selection detects a port occupied on its IPv4 host', async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => occupied.close(resolve)));

  const occupiedPort = occupied.address().port;
  const selectedPort = await ports.getFreePort(occupiedPort, '127.0.0.1');
  assert.notEqual(selectedPort, occupiedPort);
  assert.ok(Number.isInteger(selectedPort) && selectedPort > 0);
});
