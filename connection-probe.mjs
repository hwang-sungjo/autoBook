import https from 'node:https';
import { performance } from 'node:perf_hooks';

const agent = new https.Agent({ keepAlive: true, maxSockets: 2, timeout: 15_000 });

/** Local app server -> public site. These are not Chrome navigation timings. */
export function timedHead(url, { headers, signal } = {}, { requestImpl = https.request, monoNow = () => performance.now() } = {}) {
  return new Promise((resolve, reject) => {
    const started = monoNow();
    let socketAt = started;
    let dnsAt = null;
    let tcpAt = null;
    let tlsAt = null;
    let sentAt = null;
    const request = requestImpl(url, { method: 'HEAD', headers, signal, agent }, (response) => {
      const received = monoNow();
      const resultHeaders = new Headers();
      for (const key of ['date', 'age', 'x-cache']) if (typeof response.headers[key] === 'string') resultHeaders.set(key, response.headers[key]);
      const reused = request.reusedSocket === true;
      const difference = (end, start) => end !== null && start !== null ? Math.max(0, end - start) : null;
      response.resume();
      resolve({
        status: response.statusCode,
        headers: resultHeaders,
        connectionTimings: {
          scope: 'local-server-to-site', protocol: 'https-http1', reusedSocket: reused,
          dnsMs: reused ? 0 : difference(dnsAt, socketAt),
          tcpMs: reused ? 0 : difference(tcpAt, dnsAt ?? socketAt),
          tlsMs: reused ? 0 : difference(tlsAt, tcpAt),
          requestToHeadersMs: difference(received, sentAt),
          totalToHeadersMs: difference(received, started),
        },
      });
    });
    request.once('socket', (socket) => {
      socketAt = monoNow();
      if (!socket.connecting) return;
      socket.once('lookup', (error) => { if (!error) dnsAt = monoNow(); });
      socket.once('connect', () => { tcpAt = monoNow(); });
      socket.once('secureConnect', () => { tlsAt = monoNow(); });
    });
    request.once('finish', () => { sentAt = monoNow(); });
    request.once('error', reject);
    request.end();
  });
}
