import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let db, svc, server, base;
const call = async (m, p, b) => {
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};

before(async () => {
  db = await createDb({ url: '' });
  const a = createApp(db);
  svc = a.svc;
  server = a.app.listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await db.close(); });

let dept, s1, s2, alice, bob;

test('マスタ作成とバリデーション', async () => {
  dept = (await call('POST', '/api/departments', { name: '開発部' })).body;
  s1 = (await call('POST', '/api/statuses', { name: '在席', color_code: '#00AA00' })).body;
  s2 = (await call('POST', '/api/statuses', { name: '会議', color_code: '#AA0000' })).body;
  assert.equal((await call('POST', '/api/statuses', { name: 'x', color_code: 'red' })).status, 400);
  alice = (await call('POST', '/api/users', { name: 'Alice', email: 'a@x.jp', department_id: dept.id })).body;
  bob = (await call('POST', '/api/users', { name: 'Bob', email: 'b@x.jp', department_id: dept.id })).body;
  assert.equal((await call('POST', '/api/users', { name: 'Dup', email: 'a@x.jp' })).status, 409);
});

test('ステータスは最大30個', async () => {
  for (let i = 0; i < 28; i++) assert.equal((await call('POST', '/api/statuses', { name: `s${i}` })).status, 201);
  assert.equal((await call('POST', '/api/statuses', { name: 'over' })).status, 400);
  const all = (await call('GET', '/api/statuses')).body;
  for (const s of all.filter((x) => x.name.startsWith('s'))) await call('DELETE', `/api/statuses/${s.id}`);
});

test('使用中ステータスは削除不可・代理更新', async () => {
  const r = await call('PUT', `/api/users/${alice.id}/status`, { status_id: s2.id, updated_by: bob.id });
  assert.equal(r.body.status_updated_by, bob.id);
  assert.equal((await call('DELETE', `/api/statuses/${s2.id}`)).status, 409);
  const board = (await call('GET', '/api/board')).body;
  const m = board.departments[0].members.find((x) => x.id === alice.id);
  assert.equal(m.proxy_updated, true);
  assert.equal(m.updated_by_name, 'Bob');
});

test('お気に入り絞り込みと氏名検索', async () => {
  assert.equal((await call('PUT', `/api/users/${alice.id}/favorites/${alice.id}`)).status, 400);
  await call('PUT', `/api/users/${alice.id}/favorites/${bob.id}`);
  const fav = (await call('GET', `/api/board?favorites_of=${alice.id}`)).body;
  assert.deepEqual(fav.departments[0].members.map((m) => m.name), ['Bob']);
  const q = (await call('GET', '/api/board?q=ali')).body;
  assert.deepEqual(q.departments[0].members.map((m) => m.name), ['Alice']);
  await call('DELETE', `/api/users/${alice.id}/favorites/${bob.id}`);
  assert.deepEqual((await call('GET', `/api/users/${alice.id}/favorites`)).body, []);
});

test('予定の検証・ボード表示', async () => {
  const t = (h) => new Date(Date.UTC(2030, 0, 1, h)).toISOString();
  assert.equal((await call('POST', `/api/users/${bob.id}/schedules`, { status_id: s2.id, start_time: t(5), end_time: t(4) })).status, 400);
  assert.equal((await call('POST', `/api/users/${bob.id}/schedules`, { status_id: s2.id, start_time: t(1), end_time: t(3), source: 'x' })).status, 400);
  const ok = await call('POST', `/api/users/${bob.id}/schedules`, { status_id: s2.id, start_time: t(1), end_time: t(3), note: '定例' });
  assert.equal(ok.status, 201);
  const b = await svc.board({ now: new Date(t(2)) });
  const m = b.departments[0].members.find((x) => x.id === bob.id);
  assert.equal(m.current_schedule.note, '定例');
  await call('DELETE', `/api/schedules/${ok.body.id}`);
});

test('予定の自動反映: 開始で切替・手動上書き尊重・終了で既定へ復帰', async () => {
  const c = await call('POST', '/api/users', { name: 'Carol', email: 'c@x.jp', department_id: dept.id });
  const id = c.body.id;
  await call('PUT', `/api/users/${id}/status`, { status_id: s1.id });
  const start = new Date(Date.now() + 3600e3), end = new Date(Date.now() + 7200e3);
  await call('POST', `/api/users/${id}/schedules`, { status_id: s2.id, start_time: start, end_time: end });
  const st = async () => (await call('GET', `/api/users/${id}`)).body;

  await svc.applySchedules(new Date());
  assert.equal((await st()).current_status_id, s1.id, '開始前は変わらない');

  await svc.applySchedules(new Date(start.getTime() + 60e3));
  const u = await st();
  assert.equal(u.current_status_id, s2.id);
  assert.equal(u.status_updated_by, null);

  await svc.applySchedules(new Date(end.getTime() + 60e3));
  assert.equal((await st()).current_status_id, s1.id, '既定(表示順先頭)に復帰');
});

test('手動更新は予定開始後なら自動反映で上書きされない', async () => {
  const d = (await call('POST', '/api/users', { name: 'Dan', email: 'd@x.jp' })).body;
  const start = new Date(Date.now() - 3600e3);
  await call('POST', `/api/users/${d.id}/schedules`, { status_id: s2.id, start_time: start, end_time: new Date(Date.now() + 3600e3) });
  await call('PUT', `/api/users/${d.id}/status`, { status_id: s1.id });
  await svc.applySchedules(new Date());
  assert.equal((await call('GET', `/api/users/${d.id}`)).body.current_status_id, s1.id);
});

test('ICS 取り込み', async () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART:20300102T010000Z', 'DTEND:20300102T020000Z',
    'SUMMARY:顧客訪問', ' \\, 東京', 'LOCATION:丸の内', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const r = await call('POST', `/api/users/${bob.id}/schedules/import-ics`, { ics, status_id: s2.id, source: 'outlook' });
  assert.equal(r.body.imported, 1);
  assert.equal(r.body.schedules[0].source, 'outlook');
  assert.match(r.body.schedules[0].note, /顧客訪問, 東京 @ 丸の内/);
});
