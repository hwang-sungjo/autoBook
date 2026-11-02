import { performance } from 'node:perf_hooks';
import { timedHead } from './connection-probe.mjs';

export const CLOCK_ORIGINS = Object.freeze(['https://tickets.interpark.com', 'https://ticket.interpark.com']);
export const CLOCK_REFRESH_MS = 60_000;

export function clockOrigin(value = CLOCK_ORIGINS[0]) {
  return typeof value === 'string' && CLOCK_ORIGINS.includes(value) ? value : null;
}

/** HTTP Date is quantized to seconds; a cached response also needs Age. */
export function parseClockHeaders(headers, roundTripMs) {
  const httpDate = headers.get('date');
  if (!httpDate || !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(httpDate)) throw new Error('사이트가 유효한 Date 시간 정보를 제공하지 않았어요.');
  const timestamp = Date.parse(httpDate);
  if (!Number.isFinite(timestamp)) throw new Error('사이트의 Date 시간 정보를 해석할 수 없어요.');
  const rawAge = headers.get('age');
  if (rawAge !== null && !/^\d+$/.test(rawAge)) throw new Error('캐시 경과 시간(Age)이 올바르지 않아요.');
  const ageSeconds = rawAge === null ? 0 : Number(rawAge);
  if (!Number.isSafeInteger(ageSeconds) || ageSeconds > 31_536_000) throw new Error('캐시 경과 시간이 허용 범위를 넘었어요.');
  const cacheStatus = String(headers.get('x-cache') || '').slice(0, 120);
  if (/hit/i.test(cacheStatus) && rawAge === null) throw new Error('캐시된 응답에 Age가 없어 현재 시각을 추정할 수 없어요.');
  const rtt = Number(roundTripMs);
  if (!Number.isFinite(rtt) || rtt < 0 || rtt > 15_000) throw new Error('사이트 응답 지연이 너무 커요.');
  // Quantization midpoint, plus a symmetric-trip estimate. Neither is a promise
  // about the site's private booking clock or the actual page arrival time.
  const resolutionMs = rawAge === null ? 1000 : 2000;
  return {
    httpDate, ageSeconds, cacheStatus,
    anchorEpochMs: timestamp + ageSeconds * 1000 + resolutionMs / 2 + rtt / 2,
    uncertaintyMs: resolutionMs / 2 + rtt / 2,
    upstreamRttMs: rtt,
    resolutionMs,
  };
}

export function createClockService({ fetchImpl = timedHead, monoNow = () => performance.now(), refreshMs = CLOCK_REFRESH_MS, timeoutMs = 5000 } = {}) {
  const entries = new Map();
  async function sample(origin, entry) {
    entry.lastAttempt = monoNow();
    try {
      const started = monoNow();
      const response = await fetchImpl(`${origin}/`, {
        method: 'HEAD', redirect: 'manual',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const received = monoNow();
      if (response.status < 200 || response.status >= 400) throw new Error(`사이트 시간 확인 응답이 올바르지 않아요 (${response.status}).`);
      entry.sample = {
        ...parseClockHeaders(response.headers, received - started), anchorMono: received,
        connectionTimings: response.connectionTimings || null,
      };
      entry.error = null;
    } catch (error) {
      entry.error = error.name === 'TimeoutError' || error.name === 'AbortError' ? '사이트 시간 확인이 지연됐어요. 잠시 후 다시 시도해 주세요.' : '사이트 시간 정보를 확인하지 못했어요.';
      if (!entry.sample) throw new Error(entry.error);
    }
  }
  return {
    async get(origin) {
      if (!clockOrigin(origin)) throw new TypeError('지원하지 않는 시간 확인 대상이에요.');
      const started = monoNow();
      let entry = entries.get(origin);
      if (!entry) { entry = { sample: null, pending: null, lastAttempt: -Infinity, error: null }; entries.set(origin, entry); }
      if (!entry.pending && monoNow() - entry.lastAttempt >= refreshMs) {
        entry.pending = sample(origin, entry).finally(() => { entry.pending = null; });
      }
      if (entry.pending) await entry.pending;
      if (!entry.sample) throw new Error(entry.error || '사이트 시간 정보가 아직 없어요.');
      const now = monoNow();
      const sampleAgeMs = Math.max(0, now - entry.sample.anchorMono);
      const { anchorEpochMs, anchorMono, ...metadata } = entry.sample;
      return {
        sourceOrigin: origin,
        ...metadata,
        estimatedEpochMs: anchorEpochMs + sampleAgeMs,
        sampleAgeMs,
        requestProcessingMs: Math.max(0, now - started),
        refreshError: entry.error,
      };
    },
  };
}
