import express from 'express';
import { fileURLToPath } from 'node:url';
import { createService, HttpError } from './service.js';
import { parseIcs } from './ics.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((r) => {
  if (r === undefined) res.status(204).end(); else res.json(r);
}).catch(next);

const id = (req, name = 'id') => {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} が不正です`);
  return n;
};

export function createApp(db) {
  const svc = createService(db);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  const crud = (path, s) => {
    app.get(path, wrap(() => s.list()));
    app.post(path, wrap(async (req, res) => { res.status(201); return s.create(req.body); }));
    app.put(`${path}/:id`, wrap((req) => s.update(id(req), req.body)));
    app.delete(`${path}/:id`, wrap((req) => s.remove(id(req))));
  };
  crud('/api/departments', svc.departments);
  crud('/api/statuses', svc.statuses);

  app.get('/api/users', wrap(() => svc.users.list()));
  app.post('/api/users', wrap(async (req, res) => { res.status(201); return svc.users.create(req.body); }));
  app.get('/api/users/:id', wrap((req) => svc.users.get(id(req))));
  app.put('/api/users/:id', wrap((req) => svc.users.update(id(req), req.body)));
  app.delete('/api/users/:id', wrap((req) => svc.users.remove(id(req))));
  app.put('/api/users/:id/status', wrap((req) => svc.users.setStatus(id(req), req.body)));

  app.get('/api/users/:id/schedules', wrap((req) => svc.schedules.list(id(req), req.query)));
  app.post('/api/users/:id/schedules', wrap(async (req, res) => { res.status(201); return svc.schedules.create(id(req), req.body); }));
  app.post('/api/users/:id/schedules/import-ics', wrap(async (req, res) => {
    const uid = id(req);
    const { ics, status_id, source = 'google' } = req.body ?? {};
    const events = parseIcs(ics ?? '');
    const created = [];
    for (const e of events) {
      created.push(await svc.schedules.create(uid, {
        status_id, source, start_time: e.start, end_time: e.end && e.end > e.start ? e.end : null,
        note: [e.summary, e.location].filter(Boolean).join(' @ ') || null,
      }));
    }
    res.status(201);
    return { imported: created.length, schedules: created };
  }));
  app.delete('/api/schedules/:id', wrap((req) => svc.schedules.remove(id(req))));

  app.get('/api/users/:id/favorites', wrap((req) => svc.favorites.list(id(req))));
  app.put('/api/users/:id/favorites/:favId', wrap((req) => svc.favorites.add(id(req), id(req, 'favId'))));
  app.delete('/api/users/:id/favorites/:favId', wrap((req) => svc.favorites.remove(id(req), id(req, 'favId'))));

  app.get('/api/board', wrap((req) => svc.board({
    departmentId: req.query.department_id, favoritesOf: req.query.favorites_of,
    q: req.query.q, statusId: req.query.status_id,
  })));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON が不正です' });
    console.error(err);
    res.status(500).json({ error: 'サーバーエラー' });
  });

  return { app, svc };
}
