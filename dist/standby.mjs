import { formatOpening, getCountdown } from './core.mjs';
import { SiteClock, getClockOrigin, LAUNCH_KEY, readLaunch, claimLaunch, launchDecision, shouldWarmConnection, launchTargetMs, launchAdvanceMs } from './timing.mjs';

const $ = (selector) => document.querySelector(selector);
// The official site must not receive an opener capable of controlling ONDECK.
window.opener = null;
const id = new URL(location.href).searchParams.get('id');
const launchStorage = { getItem: (key) => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };
let launch = readLaunch(launchStorage);
const clock = new SiteClock({ origin: getClockOrigin(launch?.url) });
let timer;
let executing = false;
let initialSyncDone = false;
let lastHeartbeat = 0;
let checking = false;
let warmupRequested = false;
const connectionStatus = document.createElement('span');
connectionStatus.id = 'standby-connection-status';
document.querySelector('.standby-clock').append(connectionStatus);

function requestConnectionHint(record) {
  if (warmupRequested || !shouldWarmConnection(record, clock.now())) return;
  warmupRequested = true;
  for (const rel of ['dns-prefetch', 'preconnect']) {
    const link = document.createElement('link');
    link.rel = rel;
    link.href = getClockOrigin(record.url);
    link.dataset.ondeckHint = 'connection';
    document.head.append(link);
  }
}

function write(record) { launchStorage.setItem(LAUNCH_KEY, JSON.stringify(record)); }
function current() {
  const record = readLaunch(launchStorage);
  return record?.id === id ? record : null;
}
function finishStatus(record) {
  clearTimeout(timer);
  $('#standby-cancel').disabled = true;
  $('#standby-status').textContent = !record ? '이 예약이 취소되었거나 다른 예약으로 바뀌었어요.' : record.status === 'opened' ? '예매 페이지를 열었어요. 다른 대기 탭에서 실행됐을 수도 있어요.' : record.reason || '자동 열기를 취소했어요.';
  $('#standby-count').textContent = record?.status === 'opened' ? 'OPENED' : 'STOPPED';
  $('#standby-count').setAttribute('aria-label', record?.status === 'opened' ? '페이지 열기 완료' : '자동 열기 중지');
  if (launch?.url) {
    $('#standby-manual').href = launch.url;
    $('#standby-manual').hidden = false;
  }
}
function render() {
  launch = current();
  if (!launch || launch.status !== 'armed') { finishStatus(launch); return; }
  $('#standby-name').textContent = launch.name;
  const advance = launchAdvanceMs(launch);
  $('#standby-date').textContent = `공식 오픈 ${formatOpening(launch.opensAt)} KST · ${new URL(launch.url).hostname}${advance > 0 ? ` · 가정 보정 ${advance}ms 전` : ''}`;
  const snapshot = clock.snapshot();
  const count = getCountdown(new Date(launchTargetMs(launch)).toISOString(), snapshot.now);
  $('#standby-count').textContent = snapshot.fresh ? `${count.days > 0 ? `${count.days}일 ` : ''}${[count.hours, count.minutes, count.seconds].map((number) => String(number).padStart(2, '0')).join(' : ')}` : '-- : -- : --';
  $('#standby-count').setAttribute('aria-label', snapshot.fresh ? `페이지 열기까지 ${count.totalSeconds}초` : '사이트 시간 확인 중');
  $('#standby-clock-source').textContent = snapshot.fresh ? '사이트 응답 시각 기준 · 추정' : snapshot.syncing ? '사이트 시간 확인 중…' : '사이트 시간 재확인이 필요해요.';
  $('#standby-clock-detail').textContent = snapshot.fresh ? `측정 ${Math.floor(snapshot.ageMs / 1000)}초 전 · 시간 해상도 ${snapshot.resolutionMs / 1000}초${snapshot.ageSeconds > 0 ? ` · 캐시 ${snapshot.ageSeconds}초 반영` : ''}` : snapshot.error || '인터넷 연결과 로컬 서버를 확인해 주세요.';
  connectionStatus.textContent = snapshot.fresh ? `앱 서버 왕복 ${Math.round(snapshot.upstreamRttMs)}ms · 계산상 불확실성 ±${Math.ceil(snapshot.uncertaintyMs)}ms · ${snapshot.sampleCount}개 표본 중 선택${warmupRequested ? ' · 연결 준비 힌트 요청됨' : ' · 오픈 30초 전에 연결 준비'}` : '';
  $('#standby-status').textContent = snapshot.fresh ? advance > 0 ? `가정 기반 보정 적용 · 공식 오픈 ${advance}ms 전에 이동을 시도해요.` : '준비됐어요. 오픈 시각에 이 탭이 이동해요.' : '시간 정보를 확인할 때까지 이동하지 않아요.';
}
async function check() {
  if (checking) return;
  checking = true;
  try { await checkOnce(); }
  catch { finishStatus({ ...launch, status: 'error', reason: '예약 상태를 확인하지 못해 자동 열기를 중지했어요.' }); }
  finally { checking = false; }
}
async function checkOnce() {
  clearTimeout(timer);
  const record = current();
  render();
  if (!record || record.status !== 'armed' || executing) return;
  const snapshot = clock.snapshot();
  if (snapshot.fresh && shouldWarmConnection(record, snapshot.now)) requestConnectionHint(record);
  if (initialSyncDone && !clock.anchor) {
    executing = true;
    await navigator.locks.request('ondeck-launch', () => {
      const latest = current();
      if (latest?.status === 'armed') write({ ...latest, status: 'error', reason: '사이트 시간을 확인하지 못해 자동 열기를 중지했어요.' });
    });
    render(); return;
  }
  const decision = clock.anchor ? launchDecision(record, snapshot.now, snapshot.fresh) : 'wait';
  if (['open', 'expired', 'unsynced', 'invalid'].includes(decision)) {
    executing = true;
    try {
      const result = await navigator.locks.request('ondeck-launch', () => {
        const measurement = clock.snapshot();
        return claimLaunch(launchStorage, id, clock.now(), measurement.fresh, measurement);
      });
      if (result?.status === 'opened') {
        $('#standby-status').textContent = '예매 페이지로 이동하고 있어요…';
        location.replace(result.url);
        return;
      }
    } catch {
      finishStatus({ ...launch, status: 'error', reason: '예약 상태를 저장하지 못해 자동 이동을 중지했어요.' });
      return;
    }
    render(); return;
  }
  if (Date.now() - lastHeartbeat > 10_000) {
    await navigator.locks.request('ondeck-launch', () => {
      const latest = current();
      if (latest?.status === 'armed') write({ ...latest, heartbeatAtMs: Date.now(), warmupRequestedAtMs: latest.warmupRequestedAtMs || (warmupRequested ? clock.now() : null) });
    });
    lastHeartbeat = Date.now();
  }
  const remaining = clock.anchor ? launchTargetMs(record) - clock.now() : 1000;
  timer = setTimeout(check, Math.max(10, Math.min(1000, remaining)));
}
$('#standby-cancel').addEventListener('click', async () => {
  if (!navigator.locks) return;
  await navigator.locks.request('ondeck-launch', () => {
    const record = current();
    if (record?.status === 'armed') write({ ...record, status: 'cancelled', reason: '자동 열기를 취소했어요.' });
  });
  render();
});
window.addEventListener('storage', (event) => { if (event.key === LAUNCH_KEY) { render(); } });
window.addEventListener('pagehide', () => {
  // Best-effort cancellation on close/reload. A committed navigation has already
  // changed status to opened, so it is never turned back into a cancelled action.
  const record = current();
  if (record?.status === 'armed') {
    try { write({ ...record, status: 'cancelled', reason: '대기 탭을 닫거나 새로고침해 예약이 취소됐어요.' }); }
    catch { /* Storage failures cannot safely resume a launch. */ }
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });

if (!launch || launch.id !== id || launch.status !== 'armed') finishStatus(current());
else if (!navigator.locks) {
  $('#standby-status').textContent = '이 브라우저는 자동 열기에 필요한 기능을 지원하지 않아요. 최신 Chrome에서 사용해 주세요.';
  $('#standby-cancel').disabled = true;
} else {
  render();
  clock.sync().then(() => { initialSyncDone = true; check(); });
  setInterval(() => { if (current()?.status === 'armed') clock.sync().then(check); }, 60_000);
}
