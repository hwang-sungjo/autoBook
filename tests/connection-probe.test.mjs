import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { timedHead } from '../connection-probe.mjs';

test('HEAD 측정은 DNS·TCP·TLS·응답 구간을 분리하고 쿠키 헤더를 반환하지 않는다', async () => {
  let mono = 0;
  let drained = false;
  const result = await timedHead('https://tickets.interpark.com/', { headers: { 'Cache-Control': 'no-cache' } }, {
    monoNow: () => mono,
    requestImpl: (url, options, callback) => {
      assert.equal(url, 'https://tickets.interpark.com/');
      assert.equal(options.method, 'HEAD');
      assert.equal(options.headers['Cache-Control'], 'no-cache');
      const request = new EventEmitter();
      request.reusedSocket = false;
      request.end = () => queueMicrotask(() => {
        const socket = new EventEmitter(); socket.connecting = true;
        mono = 1; request.emit('socket', socket);
        mono = 5; socket.emit('lookup', null);
        mono = 15; socket.emit('connect');
        mono = 35; socket.emit('secureConnect');
        mono = 36; request.emit('finish');
        mono = 46; callback({ statusCode: 302, headers: { date: 'Fri, 16 Oct 2026 06:00:00 GMT', age: '10', 'x-cache': 'Hit', 'set-cookie': 'private=value' }, resume() { drained = true; } });
      });
      return request;
    },
  });
  assert.equal(result.status, 302);
  assert.equal(drained, true);
  assert.equal(result.headers.get('age'), '10');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.deepEqual(result.connectionTimings, {
    scope: 'local-server-to-site', protocol: 'https-http1', reusedSocket: false,
    dnsMs: 4, tcpMs: 10, tlsMs: 20, requestToHeadersMs: 10, totalToHeadersMs: 46,
  });
});

test('이미 열린 소켓의 재사용을 새 DNS·TLS 연결 측정으로 오해하지 않는다', async () => {
  let mono = 0;
  const result = await timedHead('https://tickets.interpark.com/', {}, {
    monoNow: () => mono,
    requestImpl: (_url, _options, callback) => {
      const request = new EventEmitter(); request.reusedSocket = true;
      request.end = () => queueMicrotask(() => {
        mono = 1; request.emit('socket', { connecting: false });
        mono = 2; request.emit('finish');
        mono = 12; callback({ statusCode: 200, headers: {}, resume() {} });
      });
      return request;
    },
  });
  assert.equal(result.connectionTimings.reusedSocket, true);
  assert.equal(result.connectionTimings.dnsMs, 0);
  assert.equal(result.connectionTimings.tcpMs, 0);
  assert.equal(result.connectionTimings.tlsMs, 0);
  assert.equal(result.connectionTimings.requestToHeadersMs, 10);
});

test('연결 오류를 성공한 시계 표본으로 반환하지 않는다', async () => {
  await assert.rejects(timedHead('https://tickets.interpark.com/', {}, {
    requestImpl: () => {
      const request = new EventEmitter();
      request.end = () => queueMicrotask(() => request.emit('error', new Error('offline')));
      return request;
    },
  }), /offline/);
});
