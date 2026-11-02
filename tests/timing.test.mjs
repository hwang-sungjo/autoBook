import test from 'node:test';
import assert from 'node:assert/strict';
import { createClockService, parseClockHeaders, clockOrigin } from '../server-clock.mjs';
import { SiteClock, clockAnchor, getClockOrigin, normalizeLaunch, launchDecision, claimLaunch, readLaunch, LAUNCH_KEY, CLOCK_MAX_AGE_MS, selectClockSamples, shouldWarmConnection, launchTargetMs, launchAdvanceMs } from '../dist/timing.mjs';

const origin = 'https://tickets.interpark.com';
const date = 'Fri, 16 Oct 2026 06:00:00 GMT';
const epoch = Date.parse(date);
const packet = { sourceOrigin: origin, httpDate: date, estimatedEpochMs: epoch, sampleAgeMs: 0, requestProcessingMs: 100, uncertaintyMs: 1000, upstreamRttMs: 100, resolutionMs: 1000, ageSeconds: 0 };
const schedule = { version: 1, id: 'test-launch', name: '가상 경기', url: `${origin}/`, opensAt: new Date(epoch).toISOString(), status: 'armed', heartbeatAtMs: epoch - 1000 };
function memoryStorage(value = schedule) {
  const values = new Map([[LAUNCH_KEY, JSON.stringify(value)]]);
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('사이트 Date에 Age와 응답 지연을 반영하고 초 단위 해상도를 보존한다', () => {
  const cached = parseClockHeaders(new Headers({ date, age: '21600', 'x-cache': 'Hit from cloudfront' }), 200);
  assert.equal(cached.anchorEpochMs, epoch + 21_600_000 + 1000 + 100);
  assert.equal(cached.resolutionMs, 2000);
  assert.equal(cached.uncertaintyMs, 1100);
  const fresh = parseClockHeaders(new Headers({ date }), 100);
  assert.equal(fresh.anchorEpochMs, epoch + 500 + 50);
  assert.equal(fresh.resolutionMs, 1000);
});

test('시간 헤더가 없거나 캐시 나이와 지연이 유효하지 않으면 동기화하지 않는다', () => {
  for (const headers of [{}, { date: 'invalid' }, { date, age: '-1' }, { date, age: '1.5' }, { date, age: '999999999' }, { date, 'x-cache': 'Hit from cloudfront' }]) {
    assert.throws(() => parseClockHeaders(new Headers(headers), 100));
  }
  for (const delay of [NaN, -1, 15001, Infinity]) assert.throws(() => parseClockHeaders(new Headers({ date }), delay));
});

test('시간 확인은 허용한 origin의 루트 HEAD만 사용하고 요청을 합쳐 1분간 재사용한다', async () => {
  let mono = 0;
  let calls = 0;
  const service = createClockService({ monoNow: () => mono, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, `${origin}/`);
    assert.equal(options.method, 'HEAD');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.credentials, undefined);
    mono += 100;
    return { status: 302, headers: new Headers({ date, age: '0' }) };
  } });
  const [first, simultaneous] = await Promise.all([service.get(origin), service.get(origin)]);
  assert.equal(calls, 1);
  assert.equal(first.estimatedEpochMs, simultaneous.estimatedEpochMs);
  mono += 10_000;
  const cached = await service.get(origin);
  assert.equal(calls, 1);
  assert.equal(cached.estimatedEpochMs - first.estimatedEpochMs, 10_000);
  assert.equal(cached.sampleAgeMs, 10_000);
  mono += 60_000;
  await service.get(origin);
  assert.equal(calls, 2);
  await assert.rejects(service.get('http://127.0.0.1/'));
  assert.equal(calls, 2);
  assert.equal(clockOrigin(`${origin}/gates/ticket/123`), null);
  assert.equal(clockOrigin('https://tickets.interpark.com.evil.test'), null);
});

test('시간 확인 실패도 재시도 간격을 지키며 기존 표본을 조용히 새 표본으로 바꾸지 않는다', async () => {
  let mono = 0;
  let calls = 0;
  const service = createClockService({ monoNow: () => mono, fetchImpl: async () => {
    calls += 1;
    if (calls > 1) throw new Error('offline');
    return { status: 200, headers: new Headers({ date }) };
  } });
  await service.get(origin);
  mono = 61_000;
  const stale = await service.get(origin);
  assert.equal(calls, 2);
  assert.ok(stale.refreshError);
  assert.equal(stale.sampleAgeMs, 61_000);
  await service.get(origin);
  assert.equal(calls, 2);
  let failures = 0;
  const offline = createClockService({ monoNow: () => mono, fetchImpl: async () => { failures += 1; throw new Error('offline'); } });
  await assert.rejects(offline.get(origin));
  await assert.rejects(offline.get(origin));
  assert.equal(failures, 1);
});

test('브라우저는 중간 서버 처리 시간을 중복 보정하지 않는다', () => {
  const result = clockAnchor(packet, 120, origin);
  assert.equal(result.epochMs, epoch + 10);
  assert.equal(result.uncertaintyMs, 1010);
  assert.equal(result.localRttMs, 20);
  for (const bad of [{ ...packet, estimatedEpochMs: NaN }, { ...packet, sampleAgeMs: CLOCK_MAX_AGE_MS + 1 }, { ...packet, uncertaintyMs: -1 }, { ...packet, sourceOrigin: 'https://evil.test' }]) assert.throws(() => clockAnchor(bad, 120, origin));
  assert.equal(getClockOrigin('https://ticket.interpark.com/goods/123'), 'https://ticket.interpark.com');
  assert.equal(getClockOrigin('https://evil.test/'), origin);
});

test('브라우저 fetch를 시계 인스턴스가 아닌 전역 객체에 바인딩한다', async () => {
  const clock = new SiteClock({ fetchImpl: function () {
    assert.equal(this, globalThis);
    return Promise.resolve({ ok: true, json: async () => packet });
  } });
  await clock.sync();
  assert.equal(clock.snapshot().fresh, true);
});

test('사이트 시계는 OS 시계가 바뀌어도 단조 시계로 진행하며 표본이 오래되면 만료한다', async () => {
  let mono = 0;
  let wall = epoch - 86_400_000;
  const clock = new SiteClock({ monoNow: () => mono, wallNow: () => wall, fetchImpl: async () => {
    mono += 120;
    return { ok: true, json: async () => packet };
  } });
  assert.equal(clock.snapshot().fresh, false);
  assert.equal(clock.now(), wall);
  const first = clock.sync();
  assert.equal(clock.sync(), first);
  await first;
  assert.equal(clock.now(), epoch + 10);
  wall += 50_000;
  mono += 2000;
  assert.equal(clock.now(), epoch + 2010);
  assert.equal(clock.snapshot().fresh, true);
  mono += CLOCK_MAX_AGE_MS;
  assert.equal(clock.snapshot().fresh, false);
  clock.setOrigin('https://ticket.interpark.com');
  assert.equal(clock.snapshot().fresh, false);
  assert.equal(clock.now(), wall);
});

test('동기화 오류에서 pending을 해제하고 이전 origin의 응답을 새 시계에 적용하지 않는다', async () => {
  let release;
  const clock = new SiteClock({ fetchImpl: () => new Promise((resolve) => { release = resolve; }) });
  const pending = clock.sync();
  await Promise.resolve();
  clock.setOrigin('https://ticket.interpark.com');
  release({ ok: true, json: async () => packet });
  await pending;
  assert.equal(clock.anchor, null);
  const broken = new SiteClock({ fetchImpl: () => { throw new Error('offline'); } });
  await broken.sync();
  assert.equal(broken.pending, null);
  assert.equal(broken.snapshot().fresh, false);
  assert.match(broken.snapshot().error, /offline/);
});

test('자동 열기는 시각 전에는 대기하고 정확한 경계에서만 실행 대상으로 바뀐다', () => {
  assert.equal(launchDecision(schedule, epoch - 1, true), 'wait');
  assert.equal(launchDecision(schedule, epoch, true), 'open');
  assert.equal(launchDecision(schedule, epoch + 10_000, true), 'open');
  assert.equal(launchDecision(schedule, epoch + 10_001, true), 'expired');
  assert.equal(launchDecision(schedule, epoch, false), 'unsynced');
  assert.equal(launchDecision({ ...schedule, status: 'cancelled' }, epoch, true), 'inactive');
  assert.equal(launchDecision(schedule, NaN, true), 'invalid');
});

test('실행 상태를 이동 전에 기록해 중복 실행과 취소 후 실행을 막는다', () => {
  const storage = memoryStorage();
  assert.equal(claimLaunch(storage, schedule.id, epoch - 1, true), null);
  const claimed = claimLaunch(storage, schedule.id, epoch + 20, true);
  assert.equal(claimed.status, 'opened');
  assert.equal(claimed.latenessMs, 20);
  assert.equal(readLaunch(storage).status, 'opened');
  assert.equal(claimLaunch(storage, schedule.id, epoch + 30, true), null);
  const replaced = memoryStorage();
  assert.equal(claimLaunch(replaced, 'other-tab', epoch, true), null);
  const cancelled = memoryStorage({ ...schedule, status: 'cancelled' });
  assert.equal(claimLaunch(cancelled, schedule.id, epoch, true), null);
});

test('시간 정보 만료와 긴 정지 뒤에는 공식 페이지를 열지 않는다', () => {
  const stale = claimLaunch(memoryStorage(), schedule.id, epoch, false);
  assert.equal(stale.status, 'error');
  const late = claimLaunch(memoryStorage(), schedule.id, epoch + 20_000, true);
  assert.equal(late.status, 'expired');
});

test('저장된 자동 열기 주소와 식별자를 검증하고 저장 실패 때 실행을 허용하지 않는다', () => {
  for (const record of [null, {}, { ...schedule, version: 2 }, { ...schedule, url: 'javascript:alert(1)' }, { ...schedule, url: 'https://evil.test' }, { ...schedule, id: '../../outside' }, { ...schedule, opensAt: null }, { ...schedule, status: 'unknown' }]) assert.equal(normalizeLaunch(record), null);
  assert.equal(readLaunch({ getItem() { throw new Error('blocked'); } }), null);
  const blocked = memoryStorage();
  blocked.setItem = () => { throw new Error('quota'); };
  assert.throws(() => claimLaunch(blocked, schedule.id, epoch, true));
});

test('서로 다른 최근 표본에서 지연 불확실성이 작은 값을 선택한다', () => {
  const fast = { ...packet, atMono: 0, epochMs: epoch, uncertaintyMs: 1010, upstreamRttMs: 20 };
  const slow = { ...packet, atMono: 1000, epochMs: epoch + 1000, uncertaintyMs: 1100, upstreamRttMs: 200 };
  const selection = selectClockSamples([slow], fast, 1000);
  assert.equal(selection.best, fast);
  assert.equal(selection.sampleCount, 2);
  assert.equal(selection.jitterMs, 180);
  assert.equal(selection.minRttMs, 20);
});

test('같은 캐시 표본을 반복 조회해도 표본 수를 부풀리지 않는다', () => {
  const original = { ...packet, atMono: 0, epochMs: epoch, uncertaintyMs: 1010 };
  const same = { ...original, atMono: 5000, sampleAgeMs: 5000, epochMs: epoch + 5000, uncertaintyMs: 1002 };
  const selection = selectClockSamples([original], same, 5000);
  assert.equal(selection.sampleCount, 1);
  assert.equal(selection.best, same);
  assert.equal(selection.jitterMs, null);
  const worse = { ...same, uncertaintyMs: 1050 };
  assert.equal(selectClockSamples(selection.samples, worse, 5000).best, same);
});

test('빠르지만 오래된 표본은 버리고 유효한 새 표본을 사용한다', () => {
  const old = { ...packet, atMono: 0, epochMs: epoch, uncertaintyMs: 1001, upstreamRttMs: 2 };
  const recent = { ...packet, atMono: CLOCK_MAX_AGE_MS, epochMs: epoch + CLOCK_MAX_AGE_MS, uncertaintyMs: 1100, upstreamRttMs: 200 };
  const selection = selectClockSamples([old, recent], null, CLOCK_MAX_AGE_MS + 1);
  assert.equal(selection.sampleCount, 1);
  assert.equal(selection.best, recent);
});

test('연결 준비 힌트는 허용된 사이트의 활성 예약에서 오픈 전 30초에만 요청한다', () => {
  assert.equal(shouldWarmConnection(schedule, epoch - 30_001), false);
  assert.equal(shouldWarmConnection(schedule, epoch - 30_000), true);
  assert.equal(shouldWarmConnection(schedule, epoch - 1), true);
  assert.equal(shouldWarmConnection(schedule, epoch), false);
  assert.equal(shouldWarmConnection({ ...schedule, status: 'cancelled' }, epoch - 10), false);
  assert.equal(shouldWarmConnection({ ...schedule, url: 'https://evil.test' }, epoch - 10), false);
});

test('자동 열기 실행 시의 측정 불확실성과 네트워크 지연을 기록한다', () => {
  const result = claimLaunch(memoryStorage(), schedule.id, epoch + 4, true, { uncertaintyMs: 1050, upstreamRttMs: 100 });
  assert.equal(result.clockUncertaintyMs, 1050);
  assert.equal(result.networkRttMs, 100);
  assert.equal(result.latenessMs, 4);
  assert.equal(normalizeLaunch(result).networkRttMs, 100);
  const invalid = claimLaunch(memoryStorage(), schedule.id, epoch, true, { uncertaintyMs: NaN, upstreamRttMs: -1 });
  assert.equal(invalid.clockUncertaintyMs, null);
  assert.equal(invalid.networkRttMs, null);
});

test('가정 선행 보정은 29ms를 정확히 한 번 빼고 경계 전에는 실행하지 않는다', () => {
  const advanced = { ...schedule, timingMode: 'assumed', advanceMs: 29, assumedConcurrentUsers: 100000, assumedRttMs: 58 };
  assert.equal(launchTargetMs(advanced), epoch - 29);
  assert.equal(launchDecision(advanced, epoch - 30, true), 'wait');
  assert.equal(launchDecision(advanced, epoch - 29, true), 'open');
  assert.equal(launchDecision(advanced, epoch - 29, false), 'unsynced');
  assert.equal(launchDecision(advanced, epoch + 9971, true), 'open');
  assert.equal(launchDecision(advanced, epoch + 9972, true), 'expired');
});

test('보정된 예정 시각의 실행 지연과 공식 오픈 시각 대비 차이를 구분한다', () => {
  const advanced = { ...schedule, timingMode: 'assumed', advanceMs: 29, assumedConcurrentUsers: 100000, assumedRttMs: 58 };
  const storage = memoryStorage(advanced);
  const result = claimLaunch(storage, schedule.id, epoch - 27, true);
  assert.equal(result.latenessMs, 2);
  assert.equal(result.openingOffsetMs, -27);
  assert.equal(result.advanceMs, 29);
  assert.equal(readLaunch(storage).assumedRttMs, 58);
  assert.equal(claimLaunch(storage, schedule.id, epoch, true), null);
});

test('과거 기록과 비활성·잘못된 선행 보정값을 조기 실행에 사용하지 않는다', () => {
  assert.equal(launchAdvanceMs(schedule), 0);
  assert.equal(normalizeLaunch(schedule).advanceMs, 0);
  for (const value of [-1, 1001, Infinity, '29', NaN]) assert.equal(launchAdvanceMs({ ...schedule, timingMode: 'assumed', advanceMs: value }), 0);
  assert.equal(launchAdvanceMs({ ...schedule, timingMode: 'none', advanceMs: 29 }), 0);
  assert.equal(launchDecision(schedule, epoch - 1, true), 'wait');
});

test('연결 준비도 보정된 실행 시각의 30초 전부터 시작한다', () => {
  const advanced = { ...schedule, timingMode: 'assumed', advanceMs: 29 };
  assert.equal(shouldWarmConnection(advanced, epoch - 30030), false);
  assert.equal(shouldWarmConnection(advanced, epoch - 30029), true);
  assert.equal(shouldWarmConnection(advanced, epoch - 30), true);
  assert.equal(shouldWarmConnection(advanced, epoch - 29), false);
});
