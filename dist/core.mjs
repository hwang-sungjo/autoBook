export const STORAGE_KEY = 'ondeck.v1';
export const PRIORITY_IDS = ['infield', 'firstBase', 'field', 'aisle', 'cheering'];
export const CHECKLIST = [
  { id: 'login', label: 'NOL 티켓 로그인', detail: '예매할 계정으로 미리 로그인해요.' },
  { id: 'identity', label: '본인 인증 확인', detail: '필요한 인증을 미리 완료해요.' },
  { id: 'popup', label: '팝업 허용 확인', detail: '예매 창이 열릴 수 있도록 설정해요.' },
  { id: 'payment', label: '결제 수단 준비', detail: '직접 결제할 수단을 준비해요.' },
];

export function defaultTimingProfile() {
  return { enabled: true, assumedConcurrentUsers: 100_000, assumedRttMs: 58 };
}

export function normalizeTimingProfile(raw) {
  if (raw === undefined) return defaultTimingProfile();
  const number = (value, fallback) => {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    enabled: raw?.enabled === true,
    assumedConcurrentUsers: Math.min(10_000_000, Math.max(100_000, Math.round(number(raw?.assumedConcurrentUsers, 100_000)))),
    assumedRttMs: Math.min(2000, Math.max(0, Math.round(number(raw?.assumedRttMs, 58)))),
  };
}

export function timingAdvanceMs(profile) {
  const normalized = normalizeTimingProfile(profile);
  return normalized.enabled ? Math.round(normalized.assumedRttMs / 2) : 0;
}

export function defaultState() {
  return {
    version: 1,
    event: null,
    priorities: [...PRIORITY_IDS],
    candidates: [],
    sampleMode: true,
    selectedId: null,
    checklist: [],
    alerts: { enabled: false, leadSeconds: 60, sound: true, notifications: false },
    firedAlerts: [],
    timingProfile: defaultTimingProfile(),
  };
}

export function normalizePriorities(value) {
  const valid = Array.isArray(value) ? value.filter((id) => PRIORITY_IDS.includes(id)) : [];
  return [...new Set([...valid, ...PRIORITY_IDS])];
}

export function validateTicketUrl(value) {
  try {
    const url = new URL(String(value).trim());
    const allowed = ['tickets.interpark.com', 'ticket.interpark.com'];
    if (url.protocol !== 'https:' || !allowed.includes(url.hostname) || url.username || url.password || url.port) return null;
    return url.href;
  } catch { return null; }
}

export function parseSeoulDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+09:00`);
  if (!Number.isFinite(date.getTime()) || toSeoulInput(date.toISOString()) !== value) return null;
  return date.toISOString();
}

export function toSeoulInput(iso) {
  if (typeof iso !== 'string' || !iso.trim()) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function formatOpening(iso) {
  if (!iso || !Number.isFinite(new Date(iso).getTime())) return '한국 표준시 · KST';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso));
}

export function getCountdown(iso, now = Date.now()) {
  if (!iso || !Number.isFinite(new Date(iso).getTime())) return null;
  const totalSeconds = Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000));
  return {
    totalSeconds,
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor(totalSeconds / 3600) % 24,
    minutes: Math.floor(totalSeconds / 60) % 60,
    seconds: totalSeconds % 60,
    opened: new Date(iso).getTime() <= now,
  };
}

export function dueAlerts(event, alerts, firedAlerts, now = Date.now()) {
  if (!event || !alerts.enabled) return [];
  const opens = new Date(event.opensAt).getTime();
  if (!Number.isFinite(opens)) return [];
  // A sleeping tab may resume late. Do not send obsolete reminders after five minutes.
  if (now > opens + 300_000) return [];
  const keys = new Set(firedAlerts);
  const result = [];
  const openingKey = `${event.opensAt}:open`;
  const reminderKey = `${event.opensAt}:lead:${alerts.leadSeconds}`;
  if (now >= opens && !keys.has(openingKey)) {
    result.push({ key: openingKey, type: 'open', title: '예매 오픈 시각이에요', body: `${event.name} · 예매 페이지에서 직접 진행해 주세요.` });
  } else if (now >= opens - alerts.leadSeconds * 1000 && now < opens && !keys.has(reminderKey)) {
    result.push({ key: reminderKey, type: 'lead', title: '곧 예매가 시작돼요', body: `${event.name} · ${alerts.leadSeconds >= 60 ? `${alerts.leadSeconds / 60}분` : `${alerts.leadSeconds}초`} 전 알림` });
  }
  return result;
}

export function hydrateState(raw) {
  const state = defaultState();
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return state;
  if (raw.event && typeof raw.event === 'object') {
    const url = validateTicketUrl(raw.event.url);
    const input = toSeoulInput(raw.event.opensAt);
    const opensAt = parseSeoulDateTime(input);
    if (url && opensAt && typeof raw.event.name === 'string' && raw.event.name.trim()) {
      state.event = {
        name: raw.event.name.trim().slice(0, 100),
        venue: String(raw.event.venue || '').slice(0, 80),
        url, opensAt,
        seatCount: Math.max(1, Math.min(10, Math.round(Number(raw.event.seatCount) || 2))),
      };
    }
  }
  state.priorities = normalizePriorities(raw.priorities);
  state.candidates = Array.isArray(raw.candidates) ? raw.candidates.slice(0, 100).filter((item) => item && typeof item === 'object') : [];
  state.sampleMode = raw.sampleMode !== false;
  state.selectedId = typeof raw.selectedId === 'string' ? raw.selectedId : null;
  state.checklist = Array.isArray(raw.checklist) ? [...new Set(raw.checklist.filter((id) => CHECKLIST.some((item) => item.id === id)))] : [];
  state.alerts = {
    enabled: raw.alerts?.enabled === true && Boolean(state.event),
    leadSeconds: [10, 60, 300].includes(raw.alerts?.leadSeconds) ? raw.alerts.leadSeconds : 60,
    sound: raw.alerts?.sound !== false,
    notifications: raw.alerts?.notifications === true,
  };
  state.firedAlerts = Array.isArray(raw.firedAlerts) ? raw.firedAlerts.filter((item) => typeof item === 'string').slice(-30) : [];
  state.timingProfile = normalizeTimingProfile(raw.timingProfile);
  return state;
}
