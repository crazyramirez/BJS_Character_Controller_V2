const net = require('net');

function tryPort(port, host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, host, () => {
      const actual = probe.address().port;
      probe.close(() => resolve(actual));
    });
  });
}

/**
 * Find a free TCP port on the exact interface used by the local server.
 * `preferred` may be one port or a list tried in order: a stable port keeps
 * the page origin (and so the Builder's saved settings) the same between runs.
 * Falls back to a random free port.
 */
async function getFreePort(preferred = 3000, host = '127.0.0.1') {
  for (const port of [].concat(preferred)) {
    try { return await tryPort(port, host); } catch (_) { /* taken, try the next */ }
  }
  return tryPort(0, host);
}

module.exports = { getFreePort };
