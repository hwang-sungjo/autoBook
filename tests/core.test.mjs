import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  defaultState, normalizePriorities, validateTicketUrl, parseSeoulDateTime,
  toSeoulInput, formatOpening, getCountdown, dueAlerts, hydrateState,
  defaultTimingProfile, normalizeTimingProfile, timingAdvanceMs,
} from '../dist/core.mjs';

const opensAt = '2026-10-16T01:00:00.000Z';
const opens = Date.parse(opensAt);
const event = { name: '가상 야구 경기', venue: '가상 구장', url: 'https://tickets.interpark.com/', opensAt, seatCount: 2 };
const alerts = { enabled: true, leadSeconds: 60, sound: true, notifications: false };

test('서울 입력 시각은 UTC 저장값과 날짜 경계를 왕복한다', () => {
  assert.equal(parseSeoulDateTime('2026-10-16T10:00'), opensAt);
  assert.equal(toSeoulInput(opensAt), '2026-10-16T10:00');
  assert.equal(parseSeoulDateTime('2026-10-16T00:00'), '2026-10-15T15:00:00.000Z');
  assert.equal(toSeoulInput('2026-10-16T23:30:00-04:00'), '2026-10-17T12:30');
  assert.equal(parseSeoulDateTime('2028-02-29T12:00'), '2028-02-29T03:00:00.000Z');
});

test('서로 다른 호스트 시간대에서도 서울 시각 변환은 같다', () => {
  const source = `import { parseSeoulDateTime, toSeoulInput } from ${JSON.stringify(new URL('../dist/core.mjs', import.meta.url).href)}; process.stdout.write(JSON.stringify([parseSeoulDateTime('2026-10-16T00:00'), toSeoulInput('2026-10-16T01:00:00.000Z')]));`;
  for (const timezone of ['UTC', 'America/New_York', 'Pacific/Honolulu']) {
    const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', env: { ...process.env, TZ: timezone },
    }));
    assert.deepEqual(actual, ['2026-10-15T15:00:00.000Z', '2026-10-16T10:00'], timezone);
  }
});

test('존재하지 않는 날짜와 잘못된 서울 입력 형식을 거부한다', () => {
  for (const value of [null, undefined, 0, '', 'not-a-date', '2026-02-29T12:00', '2026-02-30T12:00',
    '2026-13-01T12:00', '2026-10-16T24:00', '2026-10-16T10:60', '2026-1-16T10:00',
    '2026-10-16T10:00:00', '2026-10-16T10:00+09:00', ' 2026-10-16T10:00']) {
    assert.equal(parseSeoulDateTime(value), null, String(value));
  }
  for (const value of [null, undefined, false, 0, '', 'not-a-date']) {
    assert.equal(toSeoulInput(value), '', String(value));
  }
  assert.match(formatOpening(opensAt), /10월 16일/);
  assert.equal(formatOpening(null), '한국 표준시 · KST');
});

test('카운트다운은 남은 초를 올림하고 오픈 시각에 정확히 전환한다', () => {
  assert.deepEqual(getCountdown(opensAt, opens - 90_061_000), {
    totalSeconds: 90061, days: 1, hours: 1, minutes: 1, seconds: 1, opened: false,
  });
  assert.equal(getCountdown(opensAt, opens - 1001).totalSeconds, 2);
  assert.equal(getCountdown(opensAt, opens - 1).totalSeconds, 1);
  assert.equal(getCountdown(opensAt, opens - 1).opened, false);
  assert.deepEqual(getCountdown(opensAt, opens), {
    totalSeconds: 0, days: 0, hours: 0, minutes: 0, seconds: 0, opened: true,
  });
  assert.equal(getCountdown(opensAt, opens + 5000).totalSeconds, 0);
  assert.equal(getCountdown(null, opens), null);
  assert.equal(getCountdown('invalid', opens), null);
});

test('예매 주소는 HTTPS와 정확한 호스트 이름만 허용한다', () => {
  assert.equal(validateTicketUrl(' https://tickets.interpark.com/goods/123?q=abc#date '), 'https://tickets.interpark.com/goods/123?q=abc#date');
  assert.equal(validateTicketUrl('https://ticket.interpark.com/'), 'https://ticket.interpark.com/');
  assert.equal(validateTicketUrl('https://TICKETS.INTERPARK.COM/'), 'https://tickets.interpark.com/');
  for (const value of [null, undefined, '', 'not a url', 'http://tickets.interpark.com/',
    'javascript:alert(1)', 'https://tickets.interpark.com.evil.example/',
    'https://evil.tickets.interpark.com/', 'https://tickets.interpark.com./',
    'https://tickets.interpark.com@evil.example/', 'https://user@tickets.interpark.com/',
    'https://user:password@tickets.interpark.com/', 'https://tickets.interpark.com:444/',
    'https://interpark.com/', '//tickets.interpark.com/']) {
    assert.equal(validateTicketUrl(value), null, String(value));
  }
});

test('알림은 설정 경계를 넘을 때 발생하고 기록된 알림은 다시 보내지 않는다', () => {
  assert.deepEqual(dueAlerts(event, alerts, [], opens - 60_001), []);
  const reminder = dueAlerts(event, alerts, [], opens - 60_000);
  assert.equal(reminder.length, 1);
  assert.equal(reminder[0].type, 'lead');
  assert.match(reminder[0].body, /1분/);
  assert.deepEqual(dueAlerts(event, alerts, [reminder[0].key], opens - 1), []);
  const opening = dueAlerts(event, alerts, [reminder[0].key], opens);
  assert.equal(opening.length, 1);
  assert.equal(opening[0].type, 'open');
  assert.deepEqual(dueAlerts(event, alerts, [reminder[0].key, opening[0].key], opens + 1), []);
});

test('잠든 탭은 오픈 알림만 보내고 5분이 지난 알림은 건너뛴다', () => {
  assert.deepEqual(dueAlerts(event, alerts, [], opens + 1).map(({ type }) => type), ['open']);
  assert.equal(dueAlerts(event, alerts, [], opens + 300_000).length, 1);
  assert.deepEqual(dueAlerts(event, alerts, [], opens + 300_001), []);
  assert.deepEqual(dueAlerts(event, { ...alerts, enabled: false }, [], opens), []);
  assert.deepEqual(dueAlerts(null, alerts, [], opens), []);
  assert.deepEqual(dueAlerts({ ...event, opensAt: 'invalid' }, alerts, [], opens), []);
});

test('이벤트 또는 사전 알림 시각이 바뀌면 새 알림 키를 사용한다', () => {
  const previousReminder = dueAlerts(event, alerts, [], opens - 50_000)[0].key;
  const changedLead = dueAlerts(event, { ...alerts, leadSeconds: 10 }, [previousReminder], opens - 10_000);
  assert.equal(changedLead.length, 1);
  assert.match(changedLead[0].body, /10초/);
  const nextEvent = { ...event, opensAt: '2026-10-17T01:00:00.000Z' };
  const nextOpening = Date.parse(nextEvent.opensAt);
  assert.equal(dueAlerts(nextEvent, alerts, [`${opensAt}:open`], nextOpening)[0].type, 'open');
});

test('잘못된 버전과 구조의 가져오기 데이터는 기본 상태로 복원한다', () => {
  for (const raw of [null, undefined, false, 'bad', [], {}, { version: 2 }]) {
    assert.deepEqual(hydrateState(raw), defaultState());
  }
  for (const badEvent of [
    { ...event, opensAt: null }, { ...event, opensAt: false },
    { ...event, opensAt: 'invalid' }, { ...event, url: 'https://example.com/' },
    { ...event, name: '  ' },
  ]) {
    const state = hydrateState({ version: 1, event: badEvent, alerts });
    assert.equal(state.event, null);
    assert.equal(state.alerts.enabled, false);
  }
});

test('가져온 설정은 허용한 값과 크기만 유지하고 알림 활성화는 boolean만 받는다', () => {
  const raw = {
    version: 1,
    event: { ...event, name: `  ${'가'.repeat(110)}  `, venue: '나'.repeat(100), seatCount: 99 },
    priorities: ['cheering', 'cheering', 'unknown', 'infield'],
    candidates: Array.from({ length: 105 }, (_, id) => ({ id: String(id) })),
    sampleMode: false, selectedId: 42,
    checklist: ['login', 'login', 'unknown', 'payment'],
    alerts: { enabled: 'false', leadSeconds: 59, sound: false, notifications: 'true' },
    firedAlerts: [false, ...Array.from({ length: 40 }, (_, i) => `fired-${i}`)],
  };
  const snapshot = structuredClone(raw);
  const state = hydrateState(raw);
  assert.equal(state.event.name.length, 100);
  assert.equal(state.event.venue.length, 80);
  assert.equal(state.event.seatCount, 10);
  assert.deepEqual(state.priorities, ['cheering', 'infield', 'firstBase', 'field', 'aisle']);
  assert.equal(state.candidates.length, 100);
  assert.equal(state.sampleMode, false);
  assert.equal(state.selectedId, null);
  assert.deepEqual(state.checklist, ['login', 'payment']);
  assert.deepEqual(state.alerts, { enabled: false, leadSeconds: 60, sound: false, notifications: false });
  assert.equal(state.firedAlerts.length, 30);
  assert.equal(state.firedAlerts[0], 'fired-10');
  assert.deepEqual(raw, snapshot);
});

test('새 기본 상태와 우선순위 배열은 서로 독립적이다', () => {
  const first = defaultState();
  const second = defaultState();
  first.checklist.push('login');
  first.priorities.reverse();
  assert.deepEqual(second.checklist, []);
  assert.deepEqual(normalizePriorities(null), second.priorities);
  assert.deepEqual(normalizePriorities(['aisle', 'aisle', null]), ['aisle', 'infield', 'firstBase', 'field', 'cheering']);
});

test('요청한 동접 10만 명과 왕복 58ms 가정은 선행 보정 29ms로 저장된다', () => {
  assert.deepEqual(defaultTimingProfile(), { enabled: true, assumedConcurrentUsers: 100000, assumedRttMs: 58 });
  assert.equal(timingAdvanceMs(defaultTimingProfile()), 29);
  const migrated = hydrateState({ version: 1, event });
  assert.equal(timingAdvanceMs(migrated.timingProfile), 29);
  const stored = hydrateState({ version: 1, event, timingProfile: { enabled: true, assumedConcurrentUsers: 120000, assumedRttMs: 100 } });
  assert.equal(stored.timingProfile.assumedConcurrentUsers, 120000);
  assert.equal(timingAdvanceMs(stored.timingProfile), 50);
});

test('가정 인원만 바꿔도 지연을 자동으로 늘리지 않으며 끄면 선행 보정은 0이다', () => {
  assert.equal(timingAdvanceMs({ enabled: true, assumedConcurrentUsers: 500000, assumedRttMs: 58 }), 29);
  assert.equal(timingAdvanceMs({ enabled: false, assumedConcurrentUsers: 100000, assumedRttMs: 58 }), 0);
  assert.equal(timingAdvanceMs({ enabled: 'true', assumedConcurrentUsers: 100000, assumedRttMs: 58 }), 0);
});

test('가정 프로필은 수치 범위를 제한하고 서로 독립적인 기본값을 만든다', () => {
  assert.deepEqual(normalizeTimingProfile({ enabled: true, assumedConcurrentUsers: 10, assumedRttMs: 999999 }), { enabled: true, assumedConcurrentUsers: 100000, assumedRttMs: 2000 });
  assert.equal(timingAdvanceMs({ enabled: true, assumedConcurrentUsers: Infinity, assumedRttMs: -1 }), 0);
  assert.equal(timingAdvanceMs({ enabled: true, assumedRttMs: '' }), 29);
  const first = defaultState(); const second = defaultState();
  first.timingProfile.enabled = false;
  assert.equal(second.timingProfile.enabled, true);
});
