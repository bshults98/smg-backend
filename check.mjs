// Runs inside GitHub Actions. Checks cards, posts results back to the Worker.
// Dispatch mode: JOB_ID env set -> fetch that job, check, post result.
// Schedule mode: JOB_ID empty -> pull pending jobs, check, post results.

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const RESULT_TOKEN = process.env.RESULT_TOKEN || '';
const JOB_ID = process.env.JOB_ID || '';

const ENDPOINT = 'https://vista.studiomoviegrill.com/WSVistaWebClient/gift-cards/check-balance';

const SECRET = (() => {
  const v = process.env.SMG_HMAC_SECRET;
  if (!v) throw new Error('SMG_HMAC_SECRET missing');
  const bytes = Buffer.from(v, 'base64');
  if (bytes.length !== 64) throw new Error('SMG_HMAC_SECRET must decode to 64 bytes');
  return bytes;
})();
const TOKEN = (() => {
  const v = process.env.SMG_CONNECT_API_TOKEN;
  if (!v) throw new Error('SMG_CONNECT_API_TOKEN missing');
  return v;
})();

import crypto from 'node:crypto';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function httpDate() {
  const d = new Date();
  return `${DAYS[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} GMT`;
}

function computeHmac(signingInput) {
  return crypto.createHmac('sha256', SECRET).update(signingInput, 'utf8').digest('base64');
}

async function checkCard(cardNumber) {
  const requestId = crypto.randomUUID();
  const date = httpDate();
  const body = JSON.stringify({ cardNumber });
  const signingInput = `${requestId}:${date}:${TOKEN}:${body}`;
  const hmac = computeHmac(signingInput);

  const headers = {
    'connectapitoken': TOKEN,
    'hmac': hmac,
    'date': date,
    'requestid': requestId,
    'content-type': 'application/json; charset=utf-8',
    'accept-encoding': 'gzip',
    'user-agent': 'okhttp/4.11.0',
  };

  const start = Date.now();
  let response;
  try {
    response = await fetch(ENDPOINT, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    const detail = err.name === 'TimeoutError' ? 'SMG API timed out (20s)' : err.message;
    return { cardNumber, status: 'NETWORK_ERROR', detail, elapsedMs: Date.now() - start };
  }

  const elapsedMs = Date.now() - start;
  const rawBody = await response.text();
  let json = null;
  try { json = JSON.parse(rawBody); } catch {}

  return classify({ cardNumber, httpStatus: response.status, json, elapsedMs });
}

function parseExpiry(value) {
  if (!value) return null;
  const match = value.match(/\/Date\((\d+)/);
  if (match) return new Date(parseInt(match[1]));
  const d = new Date(value.replace('Z', '+00:00'));
  return isNaN(d) ? null : d;
}

function formatCents(cents) {
  const n = parseInt(cents);
  if (isNaN(n)) return '';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function maskCard(num) {
  if (!num || num.length <= 10) return '****';
  return num.slice(0, 6) + '********' + num.slice(-4);
}

function classify(result) {
  const { httpStatus, json, cardNumber } = result;
  if (!httpStatus) return { ...result, status: 'NETWORK_ERROR', detail: result.detail || 'Unknown error' };
  const responseCode = json?.responseCode;
  if ([71, 72, 79].includes(responseCode)) return { ...result, status: 'AUTH_ERROR', detail: 'Authentication configuration invalid' };
  if (httpStatus === 401 || httpStatus === 403) return { ...result, status: 'AUTH_ERROR', detail: `Authentication rejected (HTTP ${httpStatus})` };
  if (httpStatus === 429) return { ...result, status: 'RATE_LIMITED', detail: 'Server is rate limiting requests' };
  if (httpStatus >= 500) return { ...result, status: 'API_ERROR', detail: `Server error (HTTP ${httpStatus})` };
  if (httpStatus >= 400) return { ...result, status: 'INVALID', detail: `Card not found (HTTP ${httpStatus})` };
  if (responseCode !== undefined && responseCode !== 0) return { ...result, status: 'API_ERROR', detail: `Response code ${responseCode}` };

  const balanceInCents = json?.balanceInCents;
  const expiry = parseExpiry(json?.cardExpiry);

  if (balanceInCents == null && !expiry) return { ...result, status: 'UNKNOWN', detail: 'Unexpected response from server' };
  if (expiry && expiry < new Date()) return { ...result, status: 'EXPIRED', detail: `Card ${maskCard(cardNumber)} has expired` };

  const cents = parseInt(balanceInCents) || 0;
  if (cents <= 0) {
    return { ...result, status: 'ZERO_BALANCE', detail: `No balance on card ${maskCard(cardNumber)}`, balance: '$0.00', expiry: expiry ? expiry.toISOString().slice(0, 10) : null };
  }
  return { ...result, status: 'VALID', detail: 'Active card with available balance', balance: formatCents(cents), expiry: expiry ? expiry.toISOString().slice(0, 10) : null };
}

async function postResult(jobId, result) {
  if (!WORKER_URL) { console.log('WORKER_URL not set, skipping result post'); return; }
  try {
    await fetch(`${WORKER_URL}/api/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, result, token: RESULT_TOKEN }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.log('Result post failed:', err.message);
  }
}

async function runJob(jobId, cards) {
  console.log(`Job ${jobId}: checking ${cards.length} card(s)`);
  const results = [];
  for (let i = 0; i < cards.length; i += 3) {
    const chunk = cards.slice(i, i + 3);
    results.push(...await Promise.all(chunk.map(checkCard)));
    if (i + 3 < cards.length) await new Promise(r => setTimeout(r, 300));
  }
  const summary = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  console.log(`Job ${jobId} done:`, summary);
  await postResult(jobId, { results });
}

async function fetchJson(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function main() {
  if (JOB_ID) {
    const job = await fetchJson(`${WORKER_URL}/api/job?id=${JOB_ID}`);
    if (job.status !== 'pending') { console.log('Job already processed'); return; }
    const pending = await fetchJson(`${WORKER_URL}/api/pending?token=${encodeURIComponent(RESULT_TOKEN)}`);
    const mine = (pending.jobs || []).find(j => j.jobId === JOB_ID);
    if (mine) await runJob(JOB_ID, mine.cards);
    else console.log('Job not in pending list yet (age < 90s), skipping; schedule pass will handle it');
    return;
  }

  const data = await fetchJson(`${WORKER_URL}/api/pending?token=${encodeURIComponent(RESULT_TOKEN)}`);
  console.log(`Found ${(data.jobs || []).length} pending job(s)`);
  for (const job of data.jobs || []) {
    await runJob(job.jobId, job.cards);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
