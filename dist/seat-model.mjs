/** Local, manually entered seat comparisons. This module never requests inventory. */
export const DEFAULT_PRIORITIES = Object.freeze([
  Object.freeze({ id: 'infield', label: '내야' }),
  Object.freeze({ id: 'firstBase', label: '1루 쪽' }),
  Object.freeze({ id: 'field', label: '필드와 가까움' }),
  Object.freeze({ id: 'aisle', label: '통로 쪽' }),
  Object.freeze({ id: 'cheering', label: '응원석' }),
]);

const SAMPLE_NOTE = '가상 예시입니다. 실제 경기장·좌석·잔여 수량 정보가 아닙니다.';

export const DEFAULT_CANDIDATES = Object.freeze([
  Object.freeze({
    id: 'sample-a', name: '가상 A구역 · 앞쪽 통로', section: '가상 A구역', row: '3',
    seats: '1, 2', capacity: 2, infield: true, firstBase: true,
    fieldProximity: 90, aisle: true, cheering: false, obstructed: false,
    accessible: false, note: SAMPLE_NOTE,
  }),
  Object.freeze({
    id: 'sample-b', name: '가상 B구역 · 응원석', section: '가상 B구역', row: '8',
    seats: '21, 22', capacity: 2, infield: true, firstBase: true,
    fieldProximity: 55, aisle: false, cheering: true, obstructed: false,
    accessible: false, note: SAMPLE_NOTE,
  }),
  Object.freeze({
    id: 'sample-c', name: '가상 C구역 · 필드 앞', section: '가상 C구역', row: '1',
    seats: '15, 16', capacity: 2, infield: true, firstBase: false,
    fieldProximity: 98, aisle: false, cheering: false, obstructed: false,
    accessible: false, note: SAMPLE_NOTE,
  }),
  Object.freeze({
    id: 'sample-d', name: '가상 D구역 · 시야 방해', section: '가상 D구역', row: '2',
    seats: '5, 6', capacity: 2, infield: true, firstBase: true,
    fieldProximity: 95, aisle: true, cheering: true, obstructed: true,
    accessible: false, note: SAMPLE_NOTE,
  }),
  Object.freeze({
    id: 'sample-e', name: '가상 E구역 · 장애인석', section: '가상 E구역', row: '1',
    seats: '1, 2', capacity: 2, infield: true, firstBase: true,
    fieldProximity: 95, aisle: true, cheering: true, obstructed: false,
    accessible: true, note: SAMPLE_NOTE,
  }),
]);

const LABELS = new Map(DEFAULT_PRIORITIES.map(({ id, label }) => [id, label]));
const TEXT_FIELDS = { id: 100, name: 80, section: 40, row: 30, seats: 80, note: 200 };
const BOOLEAN_FIELDS = ['infield', 'firstBase', 'aisle', 'cheering', 'obstructed', 'accessible'];

function stringValue(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

function numberValue(value, fallback = 0) {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanValue(value) {
  return value === true || value === 1 ||
    (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function stableId(candidate) {
  // FNV-1a provides a repeatable local identity; this is not a security hash.
  const serialized = JSON.stringify(candidate);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619);
  }
  return `seat-${(hash >>> 0).toString(36)}`;
}

/** Normalize untrusted form/import values into the documented candidate schema. */
export function normalizeCandidate(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const candidate = {};
  for (const [key, limit] of Object.entries(TEXT_FIELDS)) candidate[key] = stringValue(source[key]).slice(0, limit);
  for (const key of BOOLEAN_FIELDS) candidate[key] = booleanValue(source[key]);
  candidate.capacity = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(numberValue(source.capacity))));
  candidate.fieldProximity = Math.min(100, Math.max(0, numberValue(source.fieldProximity)));
  candidate.name ||= candidate.section || '이름 없는 후보';
  candidate.id ||= stableId(candidate);
  return candidate;
}

/** Normalize at most 100 object candidates, preserving first ids and repairing duplicates. */
export function normalizeCandidates(input) {
  const candidates = Array.isArray(input)
    ? input.filter((item) => item && typeof item === 'object' && !Array.isArray(item)).slice(0, 100).map(normalizeCandidate)
    : [];
  // Reserve imported ids so a duplicate's suffix cannot take a later original id.
  const reserved = new Set(candidates.map(({ id }) => id));
  const used = new Set();
  return candidates.map((candidate) => {
    if (!used.has(candidate.id)) {
      used.add(candidate.id);
      return candidate;
    }
    const base = candidate.id;
    let counter = 2;
    let id;
    do {
      const suffix = `-${counter++}`;
      id = `${base.slice(0, 100 - suffix.length)}${suffix}`;
    } while (used.has(id) || reserved.has(id));
    used.add(id);
    return { ...candidate, id };
  });
}

function normalizePriorities(priorities) {
  const ordered = [];
  for (const priority of Array.isArray(priorities) ? priorities : []) {
    const id = typeof priority === 'string' ? priority : priority?.id;
    if (LABELS.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  for (const { id } of DEFAULT_PRIORITIES) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

function criterionValue(candidate, id) {
  return id === 'field' ? candidate.fieldProximity / 100 : Number(candidate[id]);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateIdentity(candidate) {
  return [candidate.id, candidate.section, candidate.row, candidate.seats, candidate.name,
    candidate.capacity, candidate.infield, candidate.firstBase, candidate.fieldProximity,
    candidate.aisle, candidate.cheering, candidate.note].join('\u0000');
}

/**
 * @param {Array<object>} candidates Manually entered candidate groups.
 * @param {Array<string|{id:string,label?:string}>} priorities Highest priority first.
 *   Unknown/duplicate ids are ignored; missing criteria follow the defaults.
 * @param {number} seatCount Required capacity (defaults to two).
 * @returns {{ranked:Array<object>,excluded:Array<object>}} Each ranked candidate
 *   has score (0–100) and matches (Korean labels). Each excluded candidate has
 *   reason (Korean string). Original objects are never mutated.
 */
export function rankCandidates(candidates, priorities = DEFAULT_PRIORITIES, seatCount = 2) {
  const ordered = normalizePriorities(priorities);
  const required = Math.max(1, Math.floor(numberValue(seatCount, 2)));
  const totalWeight = ordered.length * (ordered.length + 1) / 2;
  const ranked = [];
  const excluded = [];

  for (const input of Array.isArray(candidates) ? candidates : []) {
    const candidate = normalizeCandidate(input);
    const reasons = [];
    if (candidate.obstructed) reasons.push('시야 방해석');
    if (candidate.accessible) reasons.push('장애인석');
    if (candidate.capacity < required) reasons.push(`필요 인원 ${required}명보다 좌석 수가 적음`);
    if (reasons.length) {
      excluded.push({ ...candidate, reason: reasons.join(' · ') });
      continue;
    }

    let weighted = 0;
    const matches = [];
    ordered.forEach((id, index) => {
      const value = criterionValue(candidate, id);
      weighted += value * (ordered.length - index);
      if (value > 0) matches.push(LABELS.get(id));
    });
    ranked.push({ ...candidate, score: Math.round(weighted / totalWeight * 10000) / 100, matches });
  }

  ranked.sort((left, right) => right.score - left.score ||
    compareText(candidateIdentity(left), candidateIdentity(right)));
  excluded.sort((left, right) => compareText(candidateIdentity(left), candidateIdentity(right)));
  return { ranked, excluded };
}
