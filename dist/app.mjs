import { DEFAULT_PRIORITIES, DEFAULT_CANDIDATES, normalizeCandidate, normalizeCandidates, rankCandidates } from './seat-model.mjs';
import { STORAGE_KEY, CHECKLIST, defaultState, hydrateState, normalizePriorities, validateTicketUrl, parseSeoulDateTime, toSeoulInput, formatOpening, getCountdown, dueAlerts, normalizeTimingProfile, timingAdvanceMs } from './core.mjs';
import { SiteClock, getClockOrigin, LAUNCH_KEY, readLaunch, launchTargetMs, launchAdvanceMs } from './timing.mjs';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const svgNS = 'http://www.w3.org/2000/svg';
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const node = document.createElementNS(svgNS, 'svg');
  node.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', `#i-${name}`);
  node.append(use);
  return node;
}
function iconButton(name, label, action, extra = '') {
  const button = element('button', `icon-button ${extra}`);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  button.addEventListener('click', action);
  return button;
}

let state = defaultState();
let storageFailed = false;
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) state = hydrateState(JSON.parse(saved));
} catch { storageFailed = true; }
state.candidates = normalizeCandidates(state.candidates);
let audioContext;
let notificationApi = 'Notification' in window;
let lastCountdownPhase = '';
let lastDateLabel = '';
const labels = new Map(DEFAULT_PRIORITIES.map(({ id, label }) => [id, label]));
const siteClock = new SiteClock({ origin: getClockOrigin(state.event?.url) });
const launchStorage = { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch {
    if (!storageFailed) toast('이 브라우저에 저장할 수 없어요', '현재 화면에서는 계속 사용할 수 있어요. 내보내기로 설정을 보관해 주세요.');
    storageFailed = true;
  }
}

function toast(title, body = '', { action, actionLabel = '', duration = 6000, alert = false } = {}) {
  const region = $('#toast-region');
  const host = $('dialog[open]') || document.body;
  if (region.parentElement !== host) host.append(region);
  const item = element('div', 'toast');
  if (alert) item.setAttribute('role', 'alert');
  const content = element('div');
  content.append(element('strong', '', title));
  if (body) content.append(element('p', '', body));
  item.append(icon(alert ? 'bell' : 'check'), content);
  if (action) {
    const button = element('button', 'button button-dark', actionLabel);
    button.addEventListener('click', () => { action(); item.remove(); });
    content.append(button);
  }
  item.append(iconButton('close', '알림 닫기', () => item.remove()));
  $('#toast-region').append(item);
  while ($('#toast-region').children.length > 3) $('#toast-region').firstElementChild.remove();
  if (duration) setTimeout(() => item.remove(), duration);
}

function showDialog(id) {
  const dialog = $(id);
  dialog.showModal();
  document.body.classList.add('has-modal');
}
for (const dialog of $$('dialog')) {
  const title = $('h2', dialog);
  title.id ||= `${dialog.id}-title`;
  dialog.setAttribute('aria-labelledby', title.id);
  for (const close of $$('.close-dialog', dialog)) close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    document.body.classList.remove('has-modal');
    if ($('#toast-region').parentElement === dialog) document.body.append($('#toast-region'));
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  });
}
$('#stadium').setAttribute('role', 'group');
$('#candidate-form').elements.fieldProximity.id = 'field-proximity';
$('#candidate-form').elements.fieldProximity.closest('label').htmlFor = 'field-proximity';

const timingTools = element('section', 'timing-tools');
timingTools.setAttribute('aria-label', '사이트 시간과 자동 페이지 열기');
const timingHeader = element('div', 'timing-header');
const clockSource = element('strong', '', '사이트 시간 확인 중…');
clockSource.id = 'site-clock-source';
const syncClockButton = element('button', 'text-button timing-sync', '시간·연결 확인');
syncClockButton.id = 'sync-site-clock'; syncClockButton.append(icon('reset'));
syncClockButton.addEventListener('click', () => syncSiteClock(true));
timingHeader.append(clockSource, syncClockButton);
const clockDetail = element('p', 'timing-detail'); clockDetail.id = 'site-clock-detail';
const launchRow = element('div', 'auto-open-row');
const launchButton = element('button', 'button button-dark', '오픈 시각에 자동 열기');
launchButton.id = 'schedule-open'; launchButton.append(icon('arrow'));
const launchStatus = element('span', 'auto-open-status'); launchStatus.id = 'auto-open-status';
launchRow.append(launchButton, launchStatus);
const timingNote = element('p', 'timing-note', '초 단위 정보에 기반한 추정 범위예요. 실제 예매 서버의 시계와 다를 수 있어요. 자동 열기는 페이지 이동을 예약하는 기능이며 대기열 접수를 예약하지 않아요. 직전 실행 지연도 대기번호 발급 시간은 아니에요.');
const queueGuide = element('p', 'timing-note', '상품 상세 페이지를 미리 열고 로그인해 두세요. 한 기기에서 진행하고, 대기번호를 받으면 새로고침하거나 창을 닫지 말고 유지하세요. ');
for (const [label, url] of [['NOL 공식 예매 안내', 'https://board.yanolja.com/faq/content/index.html?id=500'], ['대기열 유의사항', 'https://board.yanolja.com/faq/content/index.html?id=491']]) {
  const link = element('a', '', label); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  if (queueGuide.querySelector('a')) queueGuide.append(document.createTextNode(' · '));
  queueGuide.append(link);
}
const timingMetrics = element('dl', 'timing-metrics');
for (const [id, label] of [['rtt', '앱 서버 왕복'], ['offset', '기기 시계 보정량'], ['uncertainty', '계산상 불확실성'], ['samples', '최근 표본'], ['jitter', '왕복 지연 변동폭'], ['launch', '직전 실행 지연']]) {
  const group = element('div');
  const value = element('dd', '', '—'); value.id = `metric-${id}`;
  group.append(element('dt', '', label), value); timingMetrics.append(group);
}
const connectionMetrics = element('p', 'connection-metrics'); connectionMetrics.id = 'connection-metrics';
const launchMetrics = element('p', 'connection-metrics'); launchMetrics.id = 'last-launch-metrics';
const calibrationNote = element('p', 'timing-note calibration-note');
const profileForm = element('form', 'timing-profile'); profileForm.id = 'timing-profile-form';
const profileHeading = element('div', 'profile-heading');
profileHeading.append(element('strong', '', '가정 기반 지연 보정'), element('span', 'sample-tag', '가정값'));
const profileEnabledLabel = element('label', 'profile-enabled');
const profileEnabled = element('input'); profileEnabled.type = 'checkbox'; profileEnabled.name = 'enabled';
profileEnabledLabel.append(profileEnabled, document.createTextNode('선행 보정 적용'));
profileHeading.append(profileEnabledLabel);
const profileFields = element('div', 'profile-fields');
for (const [name, label, min, max, step] of [['assumedConcurrentUsers', '동시 접속 가정 (명)', 100000, 10000000, 1], ['assumedRttMs', '가정 왕복 지연 (ms)', 0, 2000, 1], ['dispatchMarginMs', '실행 지연 여유 (ms)', 0, 100, 1]]) {
  const field = element('label', '', label);
  const input = element('input'); input.type = 'number'; input.name = name; input.min = String(min); input.max = String(max); input.step = String(step); input.required = true;
  field.append(input); profileFields.append(field);
}
const profileOutput = element('output', 'profile-output'); profileOutput.id = 'profile-output';
const profileSave = element('button', 'button button-white', '보정값 저장'); profileSave.type = 'submit';
profileFields.append(profileOutput, profileSave);
profileForm.append(profileHeading, profileFields, element('p', 'profile-explanation', '왕복 지연의 절반에 실행 지연 여유를 더해 최대 1,000ms 먼저 이동해요. 실행 지연은 매번 달라질 수 있어요. 접속자 수나 대기 순번만으로 필요한 선행 시간을 계산할 수 없으며 오픈 전에 도착할 수 있어요.'));
profileForm.addEventListener('input', previewTimingProfile);
profileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const profile = formTimingProfile();
  if (JSON.stringify(profile) !== JSON.stringify(state.timingProfile)) await cancelAutomatic('보정값을 바꿔 기존 자동 열기를 취소했어요. 새 값으로 다시 예약해 주세요.');
  state.timingProfile = profile; save(); renderTimingProfile(); renderTiming();
  toast('가정 기반 보정값을 저장했어요', `${profile.assumedConcurrentUsers.toLocaleString('ko-KR')}명 접속 · 왕복 ${profile.assumedRttMs}ms 가정 + 실행 여유 ${profile.dispatchMarginMs || 0}ms · ${timingAdvanceMs(profile)}ms 미리 열기. 다음 자동 열기 예약에 적용돼요.`);
});
timingTools.append(timingHeader, clockDetail, launchRow, timingMetrics, connectionMetrics, launchMetrics, profileForm, calibrationNote, queueGuide, timingNote);
$('.dashboard-grid').after(timingTools);

function formTimingProfile() {
  return normalizeTimingProfile({ enabled: profileEnabled.checked, assumedConcurrentUsers: profileForm.elements.assumedConcurrentUsers.value, assumedRttMs: profileForm.elements.assumedRttMs.value, dispatchMarginMs: profileForm.elements.dispatchMarginMs.value });
}
function previewTimingProfile() {
  const profile = formTimingProfile();
  profileOutput.textContent = `선행 보정 ${timingAdvanceMs(profile)}ms`;
}
function renderTimingProfile() {
  const profile = state.timingProfile;
  profileEnabled.checked = profile.enabled;
  profileForm.elements.assumedConcurrentUsers.value = profile.assumedConcurrentUsers;
  profileForm.elements.assumedRttMs.value = profile.assumedRttMs;
  profileForm.elements.dispatchMarginMs.value = profile.dispatchMarginMs || 0;
  previewTimingProfile();
}

function renderTiming() {
  const snapshot = siteClock.snapshot();
  clockSource.textContent = snapshot.fresh ? snapshot.error ? '이전 사이트 시간 추정 유지' : '사이트 시간 보정됨 · 추정' : snapshot.syncing ? '사이트 시간 확인 중…' : siteClock.anchor ? '시간 재확인 필요 · 이전 추정 유지' : '시간 확인 실패 · 기기 시계 표시';
  syncClockButton.disabled = snapshot.syncing;
  const timeText = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(snapshot.now);
  clockDetail.textContent = snapshot.fresh ? `${timeText} KST · 측정 ${Math.floor(snapshot.ageMs / 1000)}초 전 · 시간 해상도 ${snapshot.resolutionMs / 1000}초${snapshot.ageSeconds > 0 ? ` · 캐시 ${snapshot.ageSeconds}초 반영` : ''}` : snapshot.error || '현재 사이트의 HTTP 시간 응답을 확인하고 있어요.';
  const launch = readLaunch(launchStorage);
  const formatMs = (value) => Number.isFinite(value) ? `${Math.round(value).toLocaleString('ko-KR')}ms` : '—';
  $('#metric-rtt').textContent = formatMs(snapshot.upstreamRttMs);
  $('#metric-offset').textContent = siteClock.anchor ? `${snapshot.offsetMs >= 0 ? '+' : ''}${formatMs(snapshot.offsetMs)}` : '보정 전';
  $('#metric-uncertainty').textContent = Number.isFinite(snapshot.uncertaintyMs) ? `±${formatMs(snapshot.uncertaintyMs)}` : '측정 전';
  $('#metric-samples').textContent = `${snapshot.sampleCount}개`;
  $('#metric-jitter').textContent = snapshot.sampleCount > 1 ? formatMs(snapshot.jitterMs) : '표본 수집 중';
  $('#metric-launch').textContent = launch?.status === 'opened' ? `+${formatMs(launch.latenessMs)}` : '실행 기록 없음';
  const connection = snapshot.connectionTimings;
  connectionMetrics.textContent = connection?.scope === 'local-server-to-site'
    ? `앱 서버 → 사이트 (HTTP/1.1): DNS ${formatMs(connection.dnsMs)} · TCP ${formatMs(connection.tcpMs)} · TLS ${formatMs(connection.tlsMs)} · 요청 후 응답 헤더 ${formatMs(connection.requestToHeadersMs)}${connection.reusedSocket ? ' · 연결 재사용' : ''}. Chrome의 실제 연결·도착 시간은 별도로 측정되지 않아요.`
    : '앱 서버의 연결 구간을 측정하고 있어요. Chrome의 실제 연결·도착 시간은 이 앱에서 측정할 수 없어요.';
  const signedMs = (value) => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${formatMs(value)}` : '기록 없음';
  const launchTime = Number.isFinite(launch?.finishedAtMs) && Math.abs(launch.finishedAtMs) <= 8.64e15 ? new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23',
  }).format(launch.finishedAtMs) : '기록 없음';
  launchMetrics.textContent = launch?.status === 'opened'
    ? `직전 실행 당시 기록: 이동 명령 ${launchTime} KST (추정 사이트 시각) · 설정 선행 ${launchAdvanceMs(launch)}ms · 목표 대비 ${signedMs(launch.latenessMs)} · 공식 오픈 대비 ${signedMs(launch.openingOffsetMs)} · 앱 서버 왕복 ${formatMs(launch.networkRttMs)} · 시계 불확실성 ±${formatMs(launch.clockUncertaintyMs)}. 당시 홈페이지 측정이며 대기열 접수 지연이나 최대 트래픽 지연은 아니에요.`
    : '자동 열기 실행 후 당시의 이동 명령 시각과 측정값이 여기에 표시돼요.';
  const armed = launch?.status === 'armed';
  const advance = timingAdvanceMs(state.timingProfile);
  calibrationNote.textContent = `저장된 가정: ${state.timingProfile.assumedConcurrentUsers.toLocaleString('ko-KR')}명 이상 · 왕복 ${state.timingProfile.assumedRttMs}ms · 실행 여유 ${state.timingProfile.dispatchMarginMs || 0}ms · 선행 보정 ${advance}ms. 다음 예약에 고정 적용돼요. 대기 탭은 자동 열기 30초 전에 연결 준비 힌트를 요청해요.`;
  launchButton.textContent = armed ? '자동 열기 취소' : advance > 0 ? `오픈 ${advance}ms 전에 자동 열기` : '오픈 시각에 자동 열기';
  launchButton.append(icon(armed ? 'close' : 'arrow'));
  launchButton.disabled = !armed && (!state.event || !snapshot.fresh || !navigator.locks);
  launchButton.setAttribute('aria-pressed', String(Boolean(armed)));
  launchStatus.textContent = armed ? Date.now() - (launch.heartbeatAtMs || 0) > 25_000 ? '대기 탭의 연결을 확인해 주세요.' : `예약됨 · 선행 보정 ${launchAdvanceMs(launch)}ms · 대기 탭을 열어 두세요.` : launch?.status === 'opened' ? `공식 페이지를 한 번 열었어요 · 당시 선행 보정 ${launchAdvanceMs(launch)}ms` : launch?.status === 'error' || launch?.status === 'expired' ? launch.reason : !navigator.locks ? '최신 Chrome에서 사용할 수 있어요.' : !snapshot.fresh ? '사이트 시간 확인 후 예약할 수 있어요.' : '대기 탭을 미리 열어 준비해요.';
}

async function syncSiteClock(feedback = false) {
  siteClock.setOrigin(getClockOrigin(state.event?.url));
  const pending = siteClock.sync();
  renderClock();
  const result = await pending;
  renderClock();
  if (feedback) toast(result.fresh ? '사이트 시간 정보를 반영했어요' : '사이트 시간을 확인하지 못했어요', result.fresh ? 'Date와 캐시 경과 시간(Age)을 반영한 추정치예요.' : result.error);
}

async function cancelAutomatic(reason = '자동 열기를 취소했어요.') {
  const cancel = () => {
    const launch = readLaunch(launchStorage);
    if (launch?.status === 'armed') launchStorage.setItem(LAUNCH_KEY, JSON.stringify({ ...launch, status: 'cancelled', reason }));
  };
  try { if (navigator.locks) await navigator.locks.request('ondeck-launch', cancel); else cancel(); }
  catch { toast('자동 열기 상태를 변경하지 못했어요', '대기 탭을 직접 닫아 주세요.'); }
  renderTiming();
}

launchButton.addEventListener('click', () => {
  const active = readLaunch(launchStorage);
  if (active?.status === 'armed') { cancelAutomatic(); return; }
  if (!state.event || !siteClock.snapshot().fresh || !navigator.locks) return;
  const advanceMs = timingAdvanceMs(state.timingProfile);
  const record = {
    version: 1, id: crypto.randomUUID(), name: state.event.name, url: state.event.url, opensAt: state.event.opensAt, status: 'armed', heartbeatAtMs: Date.now(),
    timingMode: advanceMs > 0 ? 'assumed' : 'none', advanceMs,
    assumedConcurrentUsers: state.timingProfile.assumedConcurrentUsers, assumedRttMs: state.timingProfile.assumedRttMs,
    dispatchMarginMs: state.timingProfile.dispatchMarginMs || 0,
  };
  if (launchTargetMs(record) <= siteClock.now()) { toast('보정된 자동 열기 시각이 지난 일정이에요', '다가오는 오픈 시각으로 일정을 수정해 주세요.'); return; }
  try { launchStorage.setItem(LAUNCH_KEY, JSON.stringify(record)); }
  catch { toast('자동 열기를 준비할 수 없어요', '브라우저의 저장 공간을 사용할 수 있어야 해요.'); return; }
  // Open during this click, while a user gesture is active. The local standby
  // tab performs one navigation later; no popup is created by a timer.
  const launchWindow = window.open(`./standby.html?id=${record.id}`, '_blank');
  if (!launchWindow) {
    launchStorage.setItem(LAUNCH_KEY, JSON.stringify({ ...record, status: 'error', reason: '대기 탭이 차단됐어요. 이 앱의 팝업을 허용한 뒤 다시 예약해 주세요.' }));
    toast('대기 탭이 열리지 않았어요', '이 앱의 팝업 허용 여부를 확인해 주세요.');
  } else toast('자동 열기를 예약했어요', `선행 보정 ${advanceMs}ms가 적용돼요. 열린 대기 탭을 앞에 두고 유지해 주세요. 대기 탭을 닫거나 새로고침하면 취소돼요.`);
  renderTiming();
});

function renderEvent() {
  const event = state.event;
  $('#event-title').textContent = event?.name || '다음 경기를 등록해 볼까요?';
  $('#event-meta').textContent = event ? `${event.venue || '경기장 미입력'} · ${event.seatCount}명 관람` : '예매 오픈 시각을 등록하면 카운트다운이 시작돼요.';
  $('#event-seat-count').textContent = `${event?.seatCount || 2}명 관람`;
  $('#opening-date').textContent = event ? formatOpening(event.opensAt) : '일정 미등록';
  $('#edit-event-label').textContent = event ? '일정 수정' : '일정 등록';
  $('#open-ticket').disabled = !event;
  $('#toggle-alert span').textContent = state.alerts.enabled ? '알림 켜짐' : '알림 켜기';
  $('#toggle-alert').setAttribute('aria-pressed', String(state.alerts.enabled));
  $('#hero-footnote').textContent = state.alerts.enabled ? `알림 설정됨 · ${state.alerts.leadSeconds >= 60 ? `${state.alerts.leadSeconds / 60}분` : `${state.alerts.leadSeconds}초`} 전과 오픈 시각에 알려드려요.` : '페이지를 열어 둔 동안 오픈 시각을 알려드려요.';
  lastCountdownPhase = '';
  renderClock();
}

function renderClock() {
  const now = siteClock.now();
  const today = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long' }).format(now);
  if (lastDateLabel !== today) { $('#today-label').textContent = today; lastDateLabel = today; }
  const countdown = getCountdown(state.event?.opensAt, now);
  const phase = countdown ? countdown.opened ? 'open' : 'upcoming' : 'empty';
  for (const key of ['days', 'hours', 'minutes', 'seconds']) $('#count-' + key).textContent = countdown ? String(countdown[key]).padStart(2, '0') : '--';
  const clockPhase = `${phase}:${siteClock.snapshot().fresh}`;
  if (clockPhase !== lastCountdownPhase) {
    const status = $('#countdown-status');
    status.replaceChildren(icon('clock'), document.createTextNode(phase === 'open' ? '오픈 시각이 지났어요 · 공식 페이지에서 확인해 주세요' : siteClock.snapshot().fresh ? '한국 표준시 KST · 사이트 응답 기준 (추정)' : siteClock.anchor ? '한국 표준시 KST · 이전 추정 (재확인 필요)' : '한국 표준시 KST · 기기 시계 기준 (보정 안 됨)'));
    $('.countdown').setAttribute('aria-label', phase === 'empty' ? '등록된 예매 일정이 없습니다' : phase === 'open' ? '예매 오픈 시각이 지났습니다' : '예매 오픈까지 남은 시간');
    lastCountdownPhase = clockPhase;
  }
  renderTiming();
}

function renderChecklist() {
  const root = $('#checklist');
  root.replaceChildren();
  for (const item of CHECKLIST) {
    const label = element('label', 'check-item');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = state.checklist.includes(item.id);
    input.addEventListener('change', () => {
      state.checklist = input.checked ? [...new Set([...state.checklist, item.id])] : state.checklist.filter((id) => id !== item.id);
      save();
      updateCheckProgress();
    });
    const content = element('span');
    content.append(element('strong', '', item.label), element('span', '', item.detail));
    label.append(input, content);
    root.append(label);
  }
  updateCheckProgress();
}
function updateCheckProgress() {
  $('#check-count').textContent = `${state.checklist.length} / ${CHECKLIST.length}`;
  // Keep CSP strict: the native progress element is not needed for four fixed stages.
  $('#check-progress').setAttribute('class', `progress-${state.checklist.length}`);
  $('.progress-track').setAttribute('role', 'progressbar');
  $('.progress-track').setAttribute('aria-label', '예매 준비 완료');
  $('.progress-track').setAttribute('aria-valuenow', state.checklist.length);
  $('.progress-track').setAttribute('aria-valuemin', 0);
  $('.progress-track').setAttribute('aria-valuemax', CHECKLIST.length);
}

function renderPriorities(focusId, direction) {
  const list = $('#priority-list');
  list.replaceChildren();
  state.priorities.forEach((id, index) => {
    const item = element('li', 'priority-item');
    item.append(element('span', 'priority-number', String(index + 1).padStart(2, '0')), element('span', 'priority-name', labels.get(id)));
    const controls = element('div', 'priority-controls');
    for (const [step, name, suffix] of [[-1, 'up', '앞으로'], [1, 'down', '뒤로']]) {
      const button = iconButton(name, `${labels.get(id)} 우선순위 ${suffix}`, () => movePriority(id, step));
      button.disabled = index + step < 0 || index + step >= state.priorities.length;
      button.dataset.priority = id;
      button.dataset.direction = String(step);
      controls.append(button);
    }
    item.append(controls);
    list.append(item);
  });
  if (focusId) {
    const preferred = $$('button', list).find((button) => button.dataset.priority === focusId && button.dataset.direction === String(direction) && !button.disabled);
    const fallback = $$('button', list).find((button) => button.dataset.priority === focusId && !button.disabled);
    (preferred || fallback)?.focus();
  }
}
function movePriority(id, step) {
  const index = state.priorities.indexOf(id);
  const target = index + step;
  if (index < 0 || target < 0 || target >= state.priorities.length) return;
  [state.priorities[index], state.priorities[target]] = [state.priorities[target], state.priorities[index]];
  save();
  renderPriorities(id, step);
  renderCandidates();
}

function currentCandidates() { return state.sampleMode ? DEFAULT_CANDIDATES : state.candidates; }
function locationLabel(candidate) {
  return [candidate.section, candidate.row ? /열$/.test(candidate.row) ? candidate.row : `${candidate.row}열` : '', candidate.seats ? `${candidate.seats}번` : '', `${candidate.capacity}석 확인`].filter(Boolean).join(' · ');
}
function selectCandidate(id) {
  state.selectedId = id;
  save();
  renderCandidates();
}

function renderCandidates() {
  const focusToken = document.activeElement?.dataset.focusToken;
  const source = currentCandidates();
  const { ranked, excluded } = rankCandidates(source, state.priorities, state.event?.seatCount || 2);
  const selected = ranked.find((candidate) => candidate.id === state.selectedId) || ranked[0];
  $('#candidate-count').textContent = String(source.length);
  $('#sample-banner').hidden = !state.sampleMode;
  $('#result-caption').textContent = `${state.event?.seatCount || 2}석 기준 · 선호 조건 5개 반영${state.sampleMode ? ' · 예시' : ''}`;
  const list = $('#candidate-list');
  list.replaceChildren();
  if (!ranked.length) {
    const empty = element('div', 'empty-state');
    empty.append(icon('seat'), element('strong', '', source.length ? '조건에 맞는 후보가 없어요' : '마음에 드는 자리를 기록해요'));
    empty.append(element('p', '', source.length ? '제외 조건과 좌석 수를 확인하거나 다른 후보를 추가해 주세요.' : '공식 좌석도에서 직접 확인한 구역과 좌석을 입력해 주세요.'));
    const add = element('button', 'button button-white', '첫 후보 추가하기');
    add.addEventListener('click', () => openCandidateForm());
    empty.append(add);
    if (!source.length && !state.sampleMode) {
      const samples = element('button', 'text-button empty-samples', '예시 후보 다시 보기');
      samples.addEventListener('click', () => { state.sampleMode = true; state.selectedId = null; save(); renderCandidates(); });
      empty.append(samples);
    }
    list.append(empty);
  }
  ranked.forEach((candidate, index) => {
    const row = element('article', `candidate-row${candidate.id === selected?.id ? ' selected' : ''}`);
    const button = element('button', 'candidate-content');
    button.dataset.focusToken = `select:${candidate.id}`;
    button.setAttribute('aria-pressed', String(candidate.id === selected?.id));
    button.setAttribute('aria-label', `${index + 1}위 ${candidate.name}, 선호도 ${Math.round(candidate.score)}점, 비교하기`);
    button.addEventListener('click', () => selectCandidate(candidate.id));
    const content = element('span', 'candidate-main');
    content.append(element('strong', 'candidate-name', candidate.name), element('span', 'candidate-location', locationLabel(candidate)));
    const score = element('span', 'candidate-score', String(Math.round(candidate.score)));
    score.title = `선호도 ${candidate.score} / 100점`;
    score.append(element('small', '', '점'));
    button.append(element('span', 'rank-badge', String(index + 1).padStart(2, '0')), content, score);
    const bottom = element('div', 'candidate-bottom');
    const tags = element('div', 'candidate-tags');
    if (candidate.matches.length) {
      for (const match of candidate.matches) tags.append(element('span', '', match === '필드와 가까움' ? `필드 ${candidate.fieldProximity}` : match));
    } else tags.append(element('span', 'tag-empty', '일치 조건 없음'));
    const tools = element('div', 'candidate-tools');
    if (!state.sampleMode) tools.append(...candidateTools(candidate));
    bottom.append(tags, tools);
    row.append(button, bottom);
    list.append(row);
  });
  $('#excluded-details').hidden = excluded.length === 0;
  $('#excluded-summary').textContent = `비교 제외 후보 ${excluded.length}개`;
  const excludedList = $('#excluded-list');
  excludedList.replaceChildren();
  for (const candidate of excluded) {
    const row = element('div', 'excluded-row');
    const text = element('div');
    text.append(element('strong', '', candidate.name), element('span', '', candidate.reason));
    row.append(text);
    if (!state.sampleMode) {
      const tools = element('div', 'excluded-tools');
      tools.append(...candidateTools(candidate));
      row.append(tools);
    }
    excludedList.append(row);
  }
  renderMap(ranked, selected);
  const summary = $('#selected-summary');
  const content = element('div');
  content.append(element('strong', '', selected ? selected.name : '후보를 눌러 비교해 보세요'), element('span', '', selected ? `${locationLabel(selected)}${selected.note && !state.sampleMode ? ` · ${selected.note}` : ' · 비교용 선택이에요'}` : '목록에서 후보를 선택하면 여기에 표시돼요.'));
  summary.replaceChildren(icon('seat'), content);
  if (focusToken) $$('[data-focus-token]').find((button) => button.dataset.focusToken === focusToken)?.focus({ preventScroll: true });
}

function candidateTools(candidate) {
  const edit = iconButton('edit', `${candidate.name} 수정`, () => openCandidateForm(candidate));
  const remove = iconButton('trash', `${candidate.name} 삭제`, () => removeCandidate(candidate.id), 'danger');
  edit.dataset.focusToken = `edit:${candidate.id}`;
  remove.dataset.focusToken = `delete:${candidate.id}`;
  return [edit, remove];
}

function renderMap(ranked, selected) {
  const group = $('#stadium-markers');
  group.replaceChildren();
  const positions = [];
  ranked.slice(0, 8).forEach((candidate, index) => {
    const side = candidate.firstBase ? 1 : -1;
    let x = candidate.infield ? 250 + side * (106 - candidate.fieldProximity * .22) : 250 + side * (64 + index * 17 % 75);
    let y = candidate.infield ? 228 + candidate.fieldProximity * .1 : 75 + index * 14 % 44;
    while (positions.some(([px, py]) => Math.hypot(px - x, py - y) < 32)) { x += side * 12; y -= 29; }
    positions.push([x, y]);
    const marker = document.createElementNS(svgNS, 'g');
    marker.setAttribute('class', `map-marker${candidate.id === selected?.id ? ' selected' : ''}`);
    marker.setAttribute('transform', `translate(${x} ${y})`);
    marker.setAttribute('role', 'button');
    marker.setAttribute('tabindex', '0');
    marker.setAttribute('aria-label', `${index + 1}위 ${candidate.name}, 비교하기`);
    marker.setAttribute('aria-pressed', String(candidate.id === selected?.id));
    marker.dataset.focusToken = `marker:${candidate.id}`;
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('r', '14');
    const text = document.createElementNS(svgNS, 'text');
    text.textContent = String(index + 1);
    const title = document.createElementNS(svgNS, 'title');
    title.textContent = `${candidate.name} · 실제 위치가 아닌 참고용 배치`;
    marker.append(title, circle, text);
    marker.addEventListener('click', () => selectCandidate(candidate.id));
    marker.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectCandidate(candidate.id); }
    });
    group.append(marker);
  });
}

function removeCandidate(id) {
  const index = state.candidates.findIndex((candidate) => candidate.id === id);
  const removed = state.candidates[index];
  if (!removed) return;
  state.candidates.splice(index, 1);
  if (state.selectedId === id) state.selectedId = null;
  save();
  renderCandidates();
  const remaining = $$('.candidate-content');
  (remaining[Math.min(index, remaining.length - 1)] || $('#add-candidate')).focus({ preventScroll: true });
  toast('후보를 삭제했어요', removed.name, { actionLabel: '되돌리기', action: () => {
    state.sampleMode = false;
    if (!state.candidates.some((candidate) => candidate.id === id)) state.candidates.splice(index, 0, removed);
    save(); renderCandidates();
  } });
}

function openEventForm() {
  const form = $('#event-form');
  form.reset();
  $('#event-error').textContent = '';
  $('#delete-event').hidden = !state.event;
  if (state.event) {
    for (const key of ['name', 'venue', 'url', 'seatCount']) form.elements[key].value = state.event[key];
    form.elements.opensAt.value = toSeoulInput(state.event.opensAt);
  }
  showDialog('#event-dialog');
  form.elements.name.focus();
}
const deleteEvent = element('button', 'text-button delete-event', '일정 삭제');
deleteEvent.id = 'delete-event'; deleteEvent.type = 'button';
deleteEvent.addEventListener('click', async () => {
  await cancelAutomatic('일정을 삭제해 자동 열기가 취소됐어요.');
  const removed = state.event;
  state.event = null; state.alerts.enabled = false; state.firedAlerts = [];
  save(); $('#event-dialog').close(); renderEvent(); renderCandidates();
  syncSiteClock();
  toast('예매 일정을 삭제했어요', '등록한 좌석 후보는 계속 비교할 수 있어요.', { actionLabel: '되돌리기', action: () => {
    state.event = removed; state.alerts.enabled = false; save(); renderEvent(); renderCandidates(); syncSiteClock();
  } });
});
$('.modal-actions', $('#event-form')).prepend(deleteEvent);
$('#edit-event').addEventListener('click', openEventForm);
$('#event-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.name.value.trim();
  const url = validateTicketUrl(form.elements.url.value);
  const opensAt = parseSeoulDateTime(form.elements.opensAt.value);
  if (!name || !url || !opensAt) {
    $('#event-error').textContent = !name ? '경기 또는 이벤트 이름을 입력해 주세요.' : !url ? 'HTTPS로 시작하는 NOL 티켓의 공식 주소를 입력해 주세요.' : '오픈 시각을 정확하게 입력해 주세요.';
    return;
  }
  const changed = !state.event || state.event.opensAt !== opensAt || state.event.name !== name || state.event.url !== url;
  if (changed) await cancelAutomatic('일정을 수정해 자동 열기가 취소됐어요.');
  state.event = { name, venue: form.elements.venue.value.trim(), url, opensAt, seatCount: Number(form.elements.seatCount.value) };
  if (changed) { state.firedAlerts = []; state.alerts.enabled = false; }
  save();
  $('#event-dialog').close();
  renderEvent(); renderCandidates();
  syncSiteClock();
  toast('예매 일정을 저장했어요', `${formatOpening(opensAt)} · KST${changed ? ' · 알림 켜기를 눌러 알림을 준비해 주세요.' : ''}`);
});

function openTicket() {
  const url = validateTicketUrl(state.event?.url);
  if (!url) { openEventForm(); return; }
  const link = element('a');
  link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  document.body.append(link); link.click(); link.remove();
}
$('#open-ticket').addEventListener('click', openTicket);

function openCandidateForm(candidate) {
  if (!candidate && !state.sampleMode && state.candidates.length >= 100) { toast('후보는 최대 100개까지 저장할 수 있어요', '기존 후보를 정리한 뒤 추가해 주세요.'); return; }
  const form = $('#candidate-form');
  form.reset();
  form.elements.id.value = '';
  $('#candidate-error').textContent = '';
  $('#candidate-dialog-title').textContent = candidate ? '좌석 후보 수정' : '좌석 후보 추가';
  if (candidate) {
    for (const key of ['id', 'name', 'section', 'row', 'seats', 'capacity', 'fieldProximity', 'note']) form.elements[key].value = candidate[key];
    for (const key of ['infield', 'firstBase', 'aisle', 'cheering', 'obstructed', 'accessible']) form.elements[key].checked = candidate[key];
  } else form.elements.capacity.value = state.event?.seatCount || 2;
  $('#proximity-output').textContent = `${form.elements.fieldProximity.value} / 100`;
  showDialog('#candidate-dialog');
  form.elements.name.focus();
}
$('#add-candidate').addEventListener('click', () => openCandidateForm());
$('#start-own-data').addEventListener('click', () => {
  state.sampleMode = false; state.selectedId = null;
  save(); renderCandidates(); openCandidateForm();
});
$('#candidate-form').elements.fieldProximity.addEventListener('input', (event) => { $('#proximity-output').textContent = `${event.target.value} / 100`; });
$('#candidate-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.elements.name.value.trim()) { $('#candidate-error').textContent = '후보 이름을 입력해 주세요.'; return; }
  const values = Object.fromEntries(new FormData(form));
  values.id ||= crypto.randomUUID();
  for (const key of ['infield', 'firstBase', 'aisle', 'cheering', 'obstructed', 'accessible']) values[key] = form.elements[key].checked;
  const candidate = normalizeCandidate(values);
  state.sampleMode = false;
  const index = state.candidates.findIndex((item) => item.id === candidate.id);
  if (index >= 0) state.candidates[index] = candidate;
  else state.candidates.push(candidate);
  state.selectedId = candidate.id;
  $('#candidate-dialog').close(); save(); renderCandidates();
  toast('좌석 후보를 저장했어요', candidate.obstructed || candidate.accessible ? '제외 조건에 해당해 선호도 순위에는 표시되지 않아요.' : '직접 확인한 정보가 바뀌면 후보를 수정해 주세요.');
});

$('#reset-priorities').addEventListener('click', () => {
  state.priorities = normalizePriorities([]); save(); renderPriorities(); renderCandidates();
  toast('선호 조건을 기본 순서로 되돌렸어요');
});

async function prepareAudio() {
  const AudioAPI = window.AudioContext || window.webkitAudioContext;
  if (!AudioAPI) return false;
  try { audioContext ||= new AudioAPI(); if (audioContext.state === 'suspended') await audioContext.resume(); return audioContext.state === 'running'; }
  catch { return false; }
}
async function playChime() {
  if (!audioContext || audioContext.state !== 'running') return false;
  try {
    [659.25, 783.99, 987.77].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + index * .16;
      oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(.12, start + .015);
      gain.gain.exponentialRampToValueAtTime(.001, start + .7);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start); oscillator.stop(start + .72);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    });
    return true;
  } catch { return false; }
}
document.addEventListener('pointerdown', () => { if (state.alerts.sound) prepareAudio(); }, { once: true });
document.addEventListener('keydown', () => { if (state.alerts.sound) prepareAudio(); }, { once: true });
$('#toggle-alert').addEventListener('click', async () => {
  if (!state.event) { toast('먼저 예매 일정을 등록해 주세요'); openEventForm(); return; }
  if (!state.alerts.enabled && new Date(state.event.opensAt).getTime() <= siteClock.now()) { toast('오픈 시각이 지난 일정이에요', '다가오는 예매 오픈 시각으로 일정을 수정해 주세요.'); return; }
  state.alerts.enabled = !state.alerts.enabled;
  save(); renderEvent();
  if (state.alerts.enabled && state.alerts.sound) await prepareAudio();
  toast(state.alerts.enabled ? '예매 알림을 켰어요' : '예매 알림을 껐어요', state.alerts.enabled ? '이 페이지를 열어 두세요. 브라우저를 닫으면 알림이 멈춰요.' : '저장한 일정은 그대로 확인할 수 있어요.');
  tickAlerts();
});

function renderNotificationStatus() {
  const permission = notificationApi ? Notification.permission : 'unsupported';
  $('#notification-status').textContent = ({ granted: '브라우저 알림이 허용되어 있어요.', denied: '브라우저 설정에서 이 사이트의 알림을 허용해 주세요.', default: '알림을 받으려면 브라우저의 허용이 필요해요.', unsupported: '이 브라우저는 데스크톱 알림을 지원하지 않아요.' })[permission];
  $('#allow-notifications').hidden = permission !== 'default';
  $('#alerts-form').elements.notifications.disabled = permission === 'unsupported';
}
$('#nav-alerts').addEventListener('click', () => {
  const form = $('#alerts-form');
  form.elements.leadSeconds.value = state.alerts.leadSeconds;
  form.elements.sound.checked = state.alerts.sound;
  form.elements.notifications.checked = state.alerts.notifications;
  renderNotificationStatus(); showDialog('#alerts-dialog');
});
$('#allow-notifications').addEventListener('click', async () => {
  if (!notificationApi) return;
  try {
    const permission = await Notification.requestPermission();
    $('#alerts-form').elements.notifications.checked = permission === 'granted';
    renderNotificationStatus();
  } catch { toast('브라우저 알림을 설정할 수 없어요', '화면 알림과 소리 알림은 계속 사용할 수 있어요.'); }
});
$('#test-sound').addEventListener('click', async () => {
  if (await prepareAudio()) { await playChime(); }
  else toast('소리 알림을 재생할 수 없어요', '브라우저의 소리 재생 설정을 확인해 주세요.');
});
$('#alerts-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const wantsNotifications = form.elements.notifications.checked;
  state.alerts = { ...state.alerts, leadSeconds: Number(form.elements.leadSeconds.value), sound: form.elements.sound.checked, notifications: wantsNotifications && notificationApi && Notification.permission === 'granted' };
  if (state.alerts.sound) prepareAudio();
  save(); renderEvent(); $('#alerts-dialog').close();
  toast('알림 설정을 저장했어요', wantsNotifications && !state.alerts.notifications ? '브라우저 알림은 허용 후 사용할 수 있어요. 화면 알림은 계속 표시돼요.' : '일정 카드의 알림 켜기로 알림을 시작할 수 있어요.');
});

function tickAlerts() {
  for (const alert of dueAlerts(state.event, state.alerts, state.firedAlerts, siteClock.now())) {
    state.firedAlerts = [...state.firedAlerts, alert.key].slice(-30);
    save();
    toast(alert.title, alert.body, { alert: true, action: openTicket, actionLabel: '예매 페이지 열기', duration: 30000 });
    if (state.alerts.sound) playChime();
    if (state.alerts.notifications && notificationApi && Notification.permission === 'granted') {
      try {
        const notification = new Notification(alert.title, { body: alert.body, icon: './icon.svg', tag: alert.key });
        notification.onclick = () => { window.focus(); notification.close(); };
        setTimeout(() => notification.close(), 30000);
      } catch { /* In-page alerts remain available when OS notifications fail. */ }
    }
  }
}

$('#export-data').addEventListener('click', () => {
  const exportState = { ...state, alerts: { ...state.alerts, enabled: false }, firedAlerts: [] };
  const blob = new Blob([JSON.stringify(exportState, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = element('a'); link.href = url; link.download = `ondeck-${toSeoulInput(new Date().toISOString()).slice(0, 10)}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('설정을 내보냈어요', '다른 브라우저에서는 사용 안내의 설정 가져오기로 불러올 수 있어요.');
});
$('#help-button').addEventListener('click', () => showDialog('#help-dialog'));
$('#import-button').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  if (file.size > 1_000_000) { toast('파일 크기는 1MB 이하여야 해요'); return; }
  try {
    const raw = JSON.parse(await file.text());
    if (!raw || raw.version !== 1 || !Array.isArray(raw.candidates) || !Array.isArray(raw.priorities)) throw new Error('invalid');
    const next = hydrateState(raw);
    if (raw.event && !next.event) throw new Error('invalid event');
    next.candidates = normalizeCandidates(next.candidates);
    next.alerts.enabled = false; next.firedAlerts = [];
    const previous = structuredClone(state);
    await cancelAutomatic('설정을 가져와 자동 열기가 취소됐어요.');
    state = next; save(); renderAll(); $('#help-dialog').close();
    syncSiteClock();
    toast('설정을 가져왔어요', '가져온 일정과 후보를 확인한 뒤 알림을 켜 주세요.', { actionLabel: '되돌리기', action: () => {
      state = previous; state.alerts.enabled = false; save(); renderAll(); syncSiteClock();
    } });
  } catch { toast('ONDECK 설정 파일을 읽을 수 없어요', '내보내기로 저장한 JSON 파일인지 확인해 주세요.'); }
});

for (const link of $$('.nav-link[href]')) link.addEventListener('click', () => {
  for (const item of $$('.nav-link[href]')) item.classList.toggle('active', item === link);
});
window.addEventListener('storage', (event) => {
  if (event.key === LAUNCH_KEY) { renderTiming(); return; }
  if (event.key !== STORAGE_KEY) return;
  try {
    state = event.newValue ? hydrateState(JSON.parse(event.newValue)) : defaultState(); state.candidates = normalizeCandidates(state.candidates);
    const launch = readLaunch(launchStorage);
    if (launch?.status === 'armed' && (!state.event || launch.opensAt !== state.event.opensAt || launch.url !== state.event.url || launch.name !== state.event.name)) cancelAutomatic('다른 앱 탭에서 일정을 바꿔 자동 열기가 취소됐어요.');
    siteClock.setOrigin(getClockOrigin(state.event?.url)); renderAll(); syncSiteClock();
  }
  catch { /* A malformed write from another tab must not replace this session. */ }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderClock(); tickAlerts(); if (!siteClock.snapshot().fresh) syncSiteClock(); } });
function renderAll() { renderTimingProfile(); renderEvent(); renderChecklist(); renderPriorities(); renderCandidates(); }
renderAll();
save();
if (storageFailed) toast('저장된 설정을 불러올 수 없어요', '현재 화면에서 새로 준비할 수 있어요. 중요한 설정은 내보내기로 보관해 주세요.');
setInterval(() => { renderClock(); tickAlerts(); }, 1000);
syncSiteClock();
setInterval(() => { if (!document.hidden) syncSiteClock(); }, 60_000);
