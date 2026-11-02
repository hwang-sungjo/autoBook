import { createClockService, clockOrigin } from '../server-clock.mjs';

// Warm instances share a measurement for one minute. Separate Vercel instances
// have separate caches; never CDN-cache a clock packet without ageing its epoch.
const siteClock = createClockService();

export default async function siteClockHandler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    res.writeHead(403).end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: '다른 사이트에서 요청할 수 없어요.' }));
    return;
  }

  const requestUrl = new URL(req.url, 'https://ondeck.invalid');
  const origin = clockOrigin(requestUrl.searchParams.get('origin') ?? undefined);
  if (!origin) {
    res.writeHead(400).end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: '지원하지 않는 사이트예요.' }));
    return;
  }
  try {
    const packet = await siteClock.get(origin);
    res.writeHead(200).end(req.method === 'HEAD' ? undefined : JSON.stringify(packet));
  } catch {
    res.writeHead(503, { 'Retry-After': '60' }).end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: '사이트 시간 정보를 확인하지 못했어요. 1분 후 다시 시도해 주세요.' }));
  }
}
