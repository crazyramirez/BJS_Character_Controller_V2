const net = require('net');

/** Find a free TCP port on the exact interface used by the local server. */
function getFreePort(preferred = 3000, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => {
      const fallback = net.createServer();
      fallback.once('error', reject);
      fallback.listen(0, host, () => {
        const port = fallback.address().port;
        fallback.close(() => resolve(port));
      });
    });
    probe.listen(preferred, host, () => {
      probe.close(() => resolve(preferred));
    });
  });
}

module.exports = { getFreePort };
