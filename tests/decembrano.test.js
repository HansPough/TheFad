/**
 * Attendance & staff module (Decembrano): every screen renders from the live
 * database and the approval guard protects the admin actions.
 * Run with: node --test tests/decembrano.test.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NAV_UNLOCKED = 'true';

const { createApp } = await import('../app.js');
const { initDb, closeDb, withClient } = await import('../db.js');

initDb();
const app = createApp();
const server = await new Promise((resolve) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
});
const base = `http://127.0.0.1:${server.address().port}`;

const jar = new Map();
const cookies = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

function absorb(response) {
  for (const line of response.headers.getSetCookie ? response.headers.getSetCookie() : []) {
    const [pair] = line.split(';');
    const [name, ...rest] = pair.split('=');
    jar.set(name.trim(), rest.join('='));
  }
}

async function get(path) {
  const response = await fetch(base + path, { headers: { cookie: cookies() }, redirect: 'manual' });
  absorb(response);
  return response;
}

async function post(path, data = {}) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { cookie: cookies(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data),
    redirect: 'manual',
  });
  absorb(response);
  return response;
}

async function page(path) {
  const response = await get(path);
  assert.equal(response.status, 200, `GET ${path} should render`);
  return response.text();
}

async function csrfFrom(path) {
  const html = await page(path);
  return /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
}

async function firstId(sql) {
  return withClient(async (client) => (await client.query(sql)).rows[0]?.id ?? null);
}

test.before(async () => {
  const token = await csrfFrom('/login');
  const response = await post('/login', { _csrf: token, username: 'dev_admin', password: 'Admin@1234' });
  assert.equal(response.status, 302);
});

test.after(() => {
  server.close();
  return closeDb();
});

test('staff list renders the real accounts', async () => {
  const html = await page('/admin/staff');
  assert.match(html, /Dev Cashier/);
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<th>Account<\/th>/);
  assert.match(html, /<th>Status<\/th>/);
  assert.match(html, /Deactivate|Reactivate/);
});

test('staff add and edit forms render', async () => {
  assert.match(await page('/admin/staff/new'), /Temporary password/);
  const edit = await page('/admin/staff/4/edit');
  assert.match(edit, /Edit staff/);
  assert.match(edit, /id="username"[^>]*readonly/);
  assert.doesNotMatch(edit, /name="password"/);
});

test('own attendance renders clock controls and real rows', async () => {
  const html = await page('/attendance/');
  assert.match(html, /Clock in|Clock out/);
  assert.match(html, /Recent shifts/);
});

test('everyone attendance renders filters and totals', async () => {
  const html = await page('/attendance/everyone');
  for (const label of ['Present', 'Late', 'Absent', 'Hours worked', 'Overtime hours']) {
    assert.match(html, new RegExp(label));
  }
});

test('everyone filters apply and impossible dates fall back quietly', async () => {
  const filtered = await page('/attendance/everyone?start=2026-11-24&end=2026-11-24');
  assert.match(filtered, /name="start" value="2026-11-24"/);
  const invalid = await page('/attendance/everyone?start=2026-13-01&end=2026-11-25');
  assert.doesNotMatch(invalid, /NaN-NaN-NaN|invalid input syntax/);
});

test('overtime screens render', async () => {
  assert.match(await page('/attendance/overtime'), /Allow overtime/);
  assert.match(await page('/attendance/overtime/new'), /Allow overtime/);
  const permitId = await firstId('SELECT permit_id AS id FROM thefad.overtime_permit ORDER BY permit_id DESC LIMIT 1');
  if (permitId) assert.match(await page(`/attendance/overtime/${permitId}`), /Extend end/);
});

test('shift screens render with the saved schedule', async () => {
  const add = await page('/attendance/shift');
  assert.match(add, /Add shift/);
  assert.match(add, /id="time_in"[^>]*value="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"/);
  const dtrId = await firstId('SELECT dtr_id AS id FROM thefad.daily_time_record ORDER BY dtr_id DESC LIMIT 1');
  if (dtrId) assert.match(await page(`/attendance/shift/${dtrId}`), /Edit shift/);
  const schedule = await page('/attendance/schedule');
  assert.match(schedule, /id="shift_start"[^>]*value="\d{2}:\d{2}"/);
});

test('account and security renders the approval PIN form', async () => {
  const html = await page('/account');
  assert.match(html, /Manager approval PIN/);
  assert.match(html, /Current password/);
});

test('admin actions refuse to run without a valid approval PIN', async () => {
  const token = await csrfFrom('/admin/staff');
  const staff = await post('/admin/staff/4/active', { _csrf: token, active: '0', approval_pin: '000000' });
  assert.equal(staff.status, 403);
  assert.match(await staff.text(), /approval PIN/);

  const schedule = await post('/attendance/schedule', { _csrf: token, shift_start: '08:00', shift_end: '16:00', grace_minutes: '10' });
  assert.equal(schedule.status, 403);
});

test('clock out without an open shift reports politely', async () => {
  const token = await csrfFrom('/attendance/');
  const response = await post('/attendance/clock-out', { _csrf: token });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/attendance/');
});
