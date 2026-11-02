import { validateTicketUrl } from './core.mjs';

export const DEFAULT_CLOCK_ORIGIN = 'https://tickets.interpark.com';
export const CLOCK_MAX_AGE_MS = 180_000;
export const LAUNCH_KEY = 'ondeck.launch.v1';
export const LAUNCH_MAX_LATENESS_MS = 10_000;
export const CONNECTION_WARMUP_MS = 30_000;
const CLOCK_DRIFT_PER_MS = 0.00005;
const ORIGINS = ['https://tickets.interpark.com', 'https://ticket.interpark.com'];

export function getClockOrigin(url) {
  const valid = validateTicketUrl(url);
  return valid ? new URL(valid).origin : DEFAULT_CLOCK_ORIGIN;
}

export function clockAnchor(packet, clientRoundTripMs, expectedOrigin) {
  if (!packet || !ORIGINS.includes(expectedOrigin) || packet.sourceOrigin !== expectedOrigin) throw new Error('시간 확인 대상이 일치하지 않아요.');
  for (const key of ['estimatedEpochMs', 'sampleAgeMs', 'requestProcessingMs', 'uncertaintyMs', 'upstreamRttMs', 'resolutionMs', 'ageSeconds']) {
    if (typeof packet[key] !== 'number' || !Number.isFinite(packet[key]) || packet[key] < 0) throw new Error('시간 응답이 올바르지 않아요.');
  }
  if (packet.estimatedEpochMs > 8.64e15 || packet.sampleAgeMs > CLOCK_MAX_AGE_MS || clientRoundTripMs < 0 || clientRoundTripMs > 15_000 || !Number.isFinite(clientRoundTripMs)) throw new Error('시간 측정값이 너무 오래됐거나 지연이 커요.');
  // API processing includes the upstream request. Subtract it before adding
  // the local transport estimate, avoiding counting that upstream delay twice.
  const localRttMs = Math.max(0, clientRoundTripMs - packet.requestProcessingMs);
  return {
    ...packet,
    epochMs: packet.estimatedEpochMs + localRttMs / 2,
    sampleAgeMs: packet.sampleAgeMs + localRttMs / 2,
    uncertaintyMs: packet.uncertaintyMs + localRttMs / 2,
    localRttMs,
  };
}

export function clockSampleKey(sample) {
  return `${sample.sourceOrigin}|${sample.httpDate}|${sample.ageSeconds}|${sample.upstreamRttMs}`;
}

/** Keep distinct recent upstream measurements; repeated cached replies are one sample. */
export function selectClockSamples(previous, candidate, atMono) {
  const valid = previous.filter((sample) => sample.sampleAgeMs + Math.max(0, atMono - sample.atMono) <= CLOCK_MAX_AGE_MS);
  if (candidate) {
    const index = valid.findIndex((sample) => clockSampleKey(sample) === clockSampleKey(candidate));
    if (index < 0) valid.push(candidate);
    else if (candidate.uncertaintyMs < valid[index].uncertaintyMs) valid[index] = candidate;
  }
  const score = (sample) => sample.uncertaintyMs + (sample.sampleAgeMs + Math.max(0, atMono - sample.atMono)) * CLOCK_DRIFT_PER_MS;
  valid.sort((left, right) => score(left) - score(right) || right.atMono - left.atMono);
  const samples = valid.slice(0, 6);
  const rtts = samples.map((sample) => sample.upstreamRttMs).sort((left, right) => left - right);
  return {
    samples, best: samples[0] || null, sampleCount: samples.length,
    minRttMs: rtts.length ? rtts[0] : null,
    maxRttMs: rtts.length ? rtts.at(-1) : null,
    jitterMs: rtts.length > 1 ? rtts.at(-1) - rtts[0] : null,
  };
}

export function shouldWarmConnection(launch, now) {
  if (!launch || launch.status !== 'armed' || !validateTicketUrl(launch.url) || !Number.isFinite(now)) return false;
  const remaining = launchTargetMs(launch) - now;
  return remaining > 0 && remaining <= CONNECTION_WARMUP_MS;
}

export function launchAdvanceMs(launch) {
  return launch?.timingMode === 'assumed' && Number.isFinite(launch.advanceMs) && launch.advanceMs >= 0 && launch.advanceMs <= 1000 ? launch.advanceMs : 0;
}

export function launchTargetMs(launch) {
  return typeof launch?.opensAt === 'string' ? Date.parse(launch.opensAt) - launchAdvanceMs(launch) : NaN;
}

export class SiteClock {
  constructor({ origin = DEFAULT_CLOCK_ORIGIN, fetchImpl = fetch, monoNow = () => performance.now(), wallNow = () => Date.now() } = {}) {
    this.origin = origin;
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.monoNow = monoNow;
    this.wallNow = wallNow;
    this.anchor = null;
    this.samples = [];
    this.error = null;
    this.pending = null;
    this.generation = 0;
  }
  setOrigin(origin) {
    if (!ORIGINS.includes(origin)) throw new TypeError('지원하지 않는 시간 확인 대상이에요.');
    if (origin !== this.origin) {
      this.origin = origin; this.anchor = null; this.samples = []; this.error = null;
      this.pending = null; this.generation += 1;
    }
  }
  chooseSample(atMono = this.monoNow()) {
    const selection = selectClockSamples(this.samples, null, atMono);
    this.samples = selection.samples;
    if (selection.best) this.anchor = selection.best;
    return selection;
  }
  now() {
    const mono = this.monoNow();
    this.chooseSample(mono);
    return this.anchor ? this.anchor.epochMs + mono - this.anchor.atMono : this.wallNow();
  }
  snapshot() {
    const selection = this.chooseSample();
    const ageMs = this.anchor ? this.anchor.sampleAgeMs + Math.max(0, this.monoNow() - this.anchor.atMono) : Infinity;
    const now = this.now();
    return {
      ...this.anchor, now, origin: this.origin, ageMs, fresh: ageMs <= CLOCK_MAX_AGE_MS,
      syncing: Boolean(this.pending), error: this.error,
      sampleCount: selection.sampleCount, minRttMs: selection.minRttMs, maxRttMs: selection.maxRttMs, jitterMs: selection.jitterMs,
      offsetMs: now - this.wallNow(),
      uncertaintyMs: this.anchor ? this.anchor.uncertaintyMs + ageMs * CLOCK_DRIFT_PER_MS : null,
    };
  }
  sync() {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const origin = this.origin;
    const run = async () => {
      try {
        const start = this.monoNow();
        const response = await this.fetchImpl(`/api/site-clock?origin=${encodeURIComponent(origin)}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error('사이트 시간 확인에 실패했어요. 인터넷 연결과 사이트 상태를 확인해 주세요.');
        const packet = await response.json();
        const end = this.monoNow();
        const anchor = clockAnchor(packet, end - start, origin);
        if (generation === this.generation) {
          const selection = selectClockSamples(this.samples, { ...anchor, atMono: end }, end);
          this.samples = selection.samples;
          this.anchor = selection.best;
          this.error = packet.refreshError || null;
        }
      } catch (error) {
        if (generation === this.generation) this.error = error.name === 'TimeoutError' ? '시간 확인 응답이 늦어지고 있어요.' : error.message;
      } finally { if (generation === this.generation) this.pending = null; }
      return this.snapshot();
    };
    this.pending = Promise.resolve().then(run);
    return this.pending;
  }
}

export function normalizeLaunch(raw) {
  if (!raw || raw.version !== 1 || typeof raw.id !== 'string' || !/^[\w-]{1,100}$/.test(raw.id)) return null;
  const url = validateTicketUrl(raw.url);
  const opens = typeof raw.opensAt === 'string' ? Date.parse(raw.opensAt) : NaN;
  if (!url || !Number.isFinite(opens) || typeof raw.name !== 'string' || !raw.name.trim()) return null;
  if (!['armed', 'opened', 'cancelled', 'expired', 'error'].includes(raw.status)) return null;
  return {
    version: 1, id: raw.id, name: raw.name.slice(0, 100), url,
    opensAt: new Date(opens).toISOString(), status: raw.status,
    timingMode: raw.timingMode === 'assumed' ? 'assumed' : 'none',
    advanceMs: launchAdvanceMs(raw),
    assumedConcurrentUsers: Number.isFinite(raw.assumedConcurrentUsers) && raw.assumedConcurrentUsers >= 100_000 && raw.assumedConcurrentUsers <= 10_000_000 ? Math.round(raw.assumedConcurrentUsers) : null,
    assumedRttMs: Number.isFinite(raw.assumedRttMs) && raw.assumedRttMs >= 0 && raw.assumedRttMs <= 2000 ? raw.assumedRttMs : null,
    ...(Number.isFinite(raw.dispatchMarginMs) && raw.dispatchMarginMs > 0 && raw.dispatchMarginMs <= 100 ? { dispatchMarginMs: Math.round(raw.dispatchMarginMs) } : {}),
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : '',
    finishedAtMs: Number.isFinite(raw.finishedAtMs) ? raw.finishedAtMs : null,
    latenessMs: Number.isFinite(raw.latenessMs) ? raw.latenessMs : null,
    heartbeatAtMs: Number.isFinite(raw.heartbeatAtMs) ? raw.heartbeatAtMs : null,
    warmupRequestedAtMs: Number.isFinite(raw.warmupRequestedAtMs) ? raw.warmupRequestedAtMs : null,
    clockUncertaintyMs: Number.isFinite(raw.clockUncertaintyMs) && raw.clockUncertaintyMs >= 0 ? raw.clockUncertaintyMs : null,
    networkRttMs: Number.isFinite(raw.networkRttMs) && raw.networkRttMs >= 0 ? raw.networkRttMs : null,
    openingOffsetMs: Number.isFinite(raw.openingOffsetMs) ? raw.openingOffsetMs : null,
  };
}

export function readLaunch(storage) {
  try { return normalizeLaunch(JSON.parse(storage.getItem(LAUNCH_KEY))); }
  catch { return null; }
}

export function launchDecision(launch, now, fresh) {
  if (!launch || launch.status !== 'armed') return 'inactive';
  const opens = launchTargetMs(launch);
  if (!Number.isFinite(now) || !Number.isFinite(opens)) return 'invalid';
  if (now < opens) return 'wait';
  if (now - opens > LAUNCH_MAX_LATENESS_MS) return 'expired';
  return fresh ? 'open' : 'unsynced';
}

/** Call only inside a cross-tab Web Lock. Marks the action before navigation. */
export function claimLaunch(storage, id, now, fresh, measurement = {}) {
  const launch = readLaunch(storage);
  if (!launch || launch.id !== id) return null;
  const decision = launchDecision(launch, now, fresh);
  if (!['open', 'expired', 'unsynced', 'invalid'].includes(decision)) return null;
  const status = decision === 'open' ? 'opened' : decision === 'expired' ? 'expired' : 'error';
  const result = {
    ...launch, status, finishedAtMs: now, latenessMs: Math.max(0, now - launchTargetMs(launch)),
    openingOffsetMs: now - Date.parse(launch.opensAt),
    clockUncertaintyMs: Number.isFinite(measurement.uncertaintyMs) && measurement.uncertaintyMs >= 0 ? measurement.uncertaintyMs : null,
    networkRttMs: Number.isFinite(measurement.upstreamRttMs) && measurement.upstreamRttMs >= 0 ? measurement.upstreamRttMs : null,
    reason: decision === 'unsynced' ? '사이트 시간 정보가 오래되어 자동 열기를 취소했어요.' : decision === 'expired' ? '대기 탭이 지연되어 오픈 시각이 10초 이상 지났어요.' : decision === 'invalid' ? '예약 시간 정보가 올바르지 않아요.' : '',
  };
  storage.setItem(LAUNCH_KEY, JSON.stringify(result));
  return result;
}
