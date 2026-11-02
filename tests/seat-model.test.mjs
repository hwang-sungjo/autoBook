import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CANDIDATES,
  DEFAULT_PRIORITIES,
  normalizeCandidate,
  normalizeCandidates,
  rankCandidates,
} from '../dist/seat-model.mjs';

const candidate = (overrides = {}) => ({
  id: 'candidate', name: '후보', section: '가상 구역', row: '1', seats: '1, 2',
  capacity: 2, infield: false, firstBase: false, fieldProximity: 0,
  aisle: false, cheering: false, obstructed: false, accessible: false, note: '',
  ...overrides,
});

test('시야 방해석과 장애인석은 모든 선호 조건을 만족해도 제외한다', () => {
  const best = candidate({ infield: true, firstBase: true, fieldProximity: 100, aisle: true, cheering: true });
  const { ranked, excluded } = rankCandidates([
    { ...best, id: 'view', obstructed: true },
    { ...best, id: 'accessible', accessible: true },
    { ...best, id: 'allowed' },
  ]);
  assert.deepEqual(ranked.map(({ id }) => id), ['allowed']);
  assert.equal(ranked[0].score, 100);
  assert.match(excluded.find(({ id }) => id === 'view').reason, /시야 방해석/);
  assert.match(excluded.find(({ id }) => id === 'accessible').reason, /장애인석/);
});

test('요청 인원만큼 좌석 수를 입력한 후보만 비교한다', () => {
  const candidates = [candidate({ id: 'one', capacity: 1 }), candidate({ id: 'two' })];
  const result = rankCandidates(candidates, DEFAULT_PRIORITIES, 2);
  assert.deepEqual(result.ranked.map(({ id }) => id), ['two']);
  assert.match(result.excluded[0].reason, /2명/);
  assert.equal(rankCandidates(candidates, DEFAULT_PRIORITIES, 1).ranked.length, 2);
  assert.equal(rankCandidates(candidates, DEFAULT_PRIORITIES, 3).ranked.length, 0);
});

test('우선순위를 바꾸면 동일한 후보의 비교 순위가 달라진다', () => {
  const candidates = [
    candidate({ id: 'infield', infield: true }),
    candidate({ id: 'cheering', cheering: true }),
  ];
  assert.equal(rankCandidates(candidates).ranked[0].id, 'infield');
  assert.equal(rankCandidates(candidates, ['cheering', 'aisle', 'field', 'firstBase', 'infield']).ranked[0].id, 'cheering');
});

test('동점 후보는 입력 순서를 바꿔도 같은 순서를 유지한다', () => {
  const candidates = [candidate({ id: 'z' }), candidate({ id: 'a' }), candidate({ id: 'm' })];
  const expected = ['a', 'm', 'z'];
  assert.deepEqual(rankCandidates(candidates).ranked.map(({ id }) => id), expected);
  assert.deepEqual(rankCandidates([...candidates].reverse()).ranked.map(({ id }) => id), expected);
});

test('잘못된 입력, 숫자 범위 및 false 문자열을 정규화한다', () => {
  const normalized = normalizeCandidate({
    name: '  앞쪽  ', capacity: '2.9', fieldProximity: 250,
    infield: 'false', firstBase: 'true', aisle: 1, cheering: false,
    obstructed: 'false', accessible: 'false', row: 2, seats: null,
  });
  assert.equal(normalized.name, '앞쪽');
  assert.equal(normalized.capacity, 2);
  assert.equal(normalized.fieldProximity, 100);
  assert.equal(normalized.infield, false);
  assert.equal(normalized.firstBase, true);
  assert.equal(normalized.aisle, true);
  assert.equal(normalized.obstructed, false);
  assert.equal(normalized.accessible, false);
  assert.equal(normalized.row, '2');
  assert.equal(normalized.seats, '');
  assert.equal(normalizeCandidate({ capacity: -2, fieldProximity: -50 }).capacity, 0);
  assert.equal(normalizeCandidate({ fieldProximity: -50 }).fieldProximity, 0);
  assert.equal(normalizeCandidate({ capacity: Infinity, fieldProximity: NaN }).fieldProximity, 0);
  assert.equal(normalizeCandidate(null).capacity, 0);
  assert.deepEqual(rankCandidates(null), { ranked: [], excluded: [] });
});

test('자동 생성한 id가 일정하고 원본 후보와 우선순위를 수정하지 않는다', () => {
  const original = candidate({ id: '', fieldProximity: 50 });
  const snapshot = structuredClone(original);
  const first = normalizeCandidate(original);
  assert.equal(first.id, normalizeCandidate(original).id);
  const priorities = [{ id: 'aisle', label: 'ignored' }, 'aisle', 'unknown'];
  const result = rankCandidates([original], priorities);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(priorities, [{ id: 'aisle', label: 'ignored' }, 'aisle', 'unknown']);
  assert.equal(result.ranked.length, 1);
  assert.equal(result.ranked[0].matches[0], '필드와 가까움');
  assert.ok(Number.isFinite(result.ranked[0].score));
});

test('가상 예시의 제외 사유와 점수가 함께 제공된다', () => {
  const { ranked, excluded } = rankCandidates(DEFAULT_CANDIDATES);
  assert.equal(ranked.length, 3);
  assert.equal(excluded.length, 2);
  assert.equal(ranked[0].id, 'sample-a');
  for (const seat of ranked) {
    assert.ok(seat.score >= 0 && seat.score <= 100);
    assert.match(seat.note, /가상 예시/);
  }
});

test('텍스트 필드는 폼에서 허용한 길이로 제한한다', () => {
  const value = '가'.repeat(250);
  const normalized = normalizeCandidate({ id: value, name: value, section: value, row: value, seats: value, note: value });
  for (const [field, length] of Object.entries({ id: 100, name: 80, section: 40, row: 30, seats: 80, note: 200 })) {
    assert.equal(normalized[field].length, length, field);
  }
  assert.equal(normalizeCandidate({ name: '   앞쪽 자리   ' }).name, '앞쪽 자리');
});

test('중복 id를 보정하고 이미 존재하는 접미사 id와 충돌하지 않는다', () => {
  const original = [candidate({ id: 'a' }), candidate({ id: 'a' }), candidate({ id: 'a-2' }), candidate({ id: 'a' })];
  const normalized = normalizeCandidates(original);
  assert.deepEqual(normalized.map(({ id }) => id), ['a', 'a-3', 'a-2', 'a-4']);
  assert.deepEqual(normalizeCandidates(original), normalized);
  assert.deepEqual(original.map(({ id }) => id), ['a', 'a', 'a-2', 'a']);
});

test('최대 길이 id의 접미사도 길이를 넘지 않고 유일하다', () => {
  const base = 'x'.repeat(100);
  const normalized = normalizeCandidates([
    candidate({ id: base }), candidate({ id: base }),
    candidate({ id: `${'x'.repeat(98)}-2` }), candidate({ id: base }),
  ]);
  assert.equal(new Set(normalized.map(({ id }) => id)).size, 4);
  assert.ok(normalized.every(({ id }) => id.length <= 100));
  assert.equal(normalized[2].id, `${'x'.repeat(98)}-2`);
});

test('후보 모음은 잘못된 항목을 걸러내고 100개까지만 유지한다', () => {
  assert.deepEqual(normalizeCandidates(null), []);
  assert.deepEqual(normalizeCandidates({}), []);
  assert.deepEqual(normalizeCandidates([null, false, 4, 'bad', []]), []);
  const normalized = normalizeCandidates([null, ...Array.from({ length: 110 }, (_, id) => candidate({ id: String(id) }))]);
  assert.equal(normalized.length, 100);
  assert.equal(normalized.at(-1).id, '99');
  const missingIds = normalizeCandidates([{}, {}]);
  assert.equal(new Set(missingIds.map(({ id }) => id)).size, 2);
  assert.ok(missingIds.every(({ id }) => id.startsWith('seat-')));
});
