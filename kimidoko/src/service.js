export const MAX_STATUSES = 30;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const bad = (m) => new HttpError(400, m);
const notFound = (m) => new HttpError(404, m);

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function str(v, field, max, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${field} は必須です`);
    return null;
  }
  const s = String(v).trim();
  if (!s && required) throw bad(`${field} は必須です`);
  if (s.length > max) throw bad(`${field} は${max}文字以内で指定してください`);
  return s;
}

function int(v, field, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${field} は必須です`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${field} は整数で指定してください`);
  return n;
}

function date(v, field, { required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${field} は必須です`);
    return null;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad(`${field} の日時形式が不正です`);
  return d.toISOString();
}

export function createService(db) {
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  async function mustExist(table, id, label) {
    const r = await one(`SELECT id FROM ${table} WHERE id=$1`, [id]);
    if (!r) throw notFound(`${label}(id=${id}) が見つかりません`);
  }

  // ---------- 部署 ----------
  const departments = {
    list: () => q('SELECT * FROM departments ORDER BY display_order, id'),
    async create(b) {
      return one('INSERT INTO departments(name, display_order) VALUES($1,$2) RETURNING *',
        [str(b.name, 'name', 100), int(b.display_order) ?? 0]);
    },
    async update(id, b) {
      const r = await one(
        'UPDATE departments SET name=COALESCE($2,name), display_order=COALESCE($3,display_order) WHERE id=$1 RETURNING *',
        [id, str(b.name, 'name', 100, { required: false }), int(b.display_order)]);
      if (!r) throw notFound('部署が見つかりません');
      return r;
    },
    async remove(id) {
      await q('UPDATE users SET department_id=NULL WHERE department_id=$1', [id]);
      const r = await one('DELETE FROM departments WHERE id=$1 RETURNING id', [id]);
      if (!r) throw notFound('部署が見つかりません');
    },
  };

  // ---------- ステータスマスタ ----------
  function checkColor(c) {
    if (c == null || c === '') return null;
    if (!COLOR_RE.test(c)) throw bad('color_code は #RRGGBB 形式で指定してください');
    return c;
  }
  const statuses = {
    list: () => q('SELECT * FROM statuses ORDER BY display_order, id'),
    async create(b) {
      const { n } = await one('SELECT COUNT(*)::int AS n FROM statuses');
      if (n >= MAX_STATUSES) throw bad(`ステータスは最大${MAX_STATUSES}個までです`);
      return one(
        'INSERT INTO statuses(name, icon_url, color_code, display_order) VALUES($1,$2,$3,$4) RETURNING *',
        [str(b.name, 'name', 50), str(b.icon_url, 'icon_url', 255, { required: false }),
          checkColor(b.color_code), int(b.display_order) ?? n]);
    },
    async update(id, b) {
      const r = await one(
        `UPDATE statuses SET name=COALESCE($2,name), icon_url=COALESCE($3,icon_url),
           color_code=COALESCE($4,color_code), display_order=COALESCE($5,display_order)
         WHERE id=$1 RETURNING *`,
        [id, str(b.name, 'name', 50, { required: false }), str(b.icon_url, 'icon_url', 255, { required: false }),
          checkColor(b.color_code), int(b.display_order)]);
      if (!r) throw notFound('ステータスが見つかりません');
      return r;
    },
    async remove(id) {
      const used = await one(
        `SELECT (SELECT COUNT(*) FROM users WHERE current_status_id=$1)::int AS u,
                (SELECT COUNT(*) FROM user_schedules WHERE status_id=$1)::int AS s`, [id]);
      if (used.u || used.s) throw new HttpError(409, '使用中のステータスは削除できません');
      const r = await one('DELETE FROM statuses WHERE id=$1 RETURNING id', [id]);
      if (!r) throw notFound('ステータスが見つかりません');
    },
  };

  // ---------- ユーザー ----------
  const users = {
    list: () => q('SELECT * FROM users ORDER BY display_order, id'),
    async get(id) {
      const r = await one('SELECT * FROM users WHERE id=$1', [id]);
      if (!r) throw notFound('ユーザーが見つかりません');
      return r;
    },
    async create(b) {
      const dept = int(b.department_id);
      if (dept != null) await mustExist('departments', dept, '部署');
      const email = str(b.email, 'email', 255);
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw bad('email の形式が不正です');
      try {
        return await one(
          'INSERT INTO users(department_id, name, email, display_order) VALUES($1,$2,$3,$4) RETURNING *',
          [dept, str(b.name, 'name', 100), email, int(b.display_order) ?? 0]);
      } catch (e) {
        if (/unique|duplicate/i.test(e.message)) throw new HttpError(409, 'そのメールアドレスは既に登録されています');
        throw e;
      }
    },
    async update(id, b) {
      const dept = int(b.department_id);
      if (dept != null) await mustExist('departments', dept, '部署');
      const r = await one(
        `UPDATE users SET department_id=COALESCE($2,department_id), name=COALESCE($3,name),
           display_order=COALESCE($4,display_order) WHERE id=$1 RETURNING *`,
        [id, dept, str(b.name, 'name', 100, { required: false }), int(b.display_order)]);
      if (!r) throw notFound('ユーザーが見つかりません');
      return r;
    },
    async remove(id) {
      await q('UPDATE users SET status_updated_by=NULL WHERE status_updated_by=$1', [id]);
      const r = await one('DELETE FROM users WHERE id=$1 RETURNING id', [id]);
      if (!r) throw notFound('ユーザーが見つかりません');
    },
    /** ステータス変更。updated_by が本人以外なら代理更新。 */
    async setStatus(id, b, now = new Date()) {
      const statusId = int(b.status_id, 'status_id', { required: true });
      const by = int(b.updated_by) ?? id;
      await mustExist('users', id, 'ユーザー');
      await mustExist('statuses', statusId, 'ステータス');
      await mustExist('users', by, '更新者');
      return one(
        `UPDATE users SET current_status_id=$2, status_updated_at=$3, status_updated_by=$4
         WHERE id=$1 RETURNING *`, [id, statusId, now.toISOString(), by]);
    },
  };

  // ---------- 行動予定 ----------
  const SOURCES = ['manual', 'google', 'outlook'];
  const schedules = {
    async list(userId, { from, to } = {}) {
      return q(
        `SELECT * FROM user_schedules WHERE user_id=$1
           AND ($2::timestamptz IS NULL OR COALESCE(end_time, start_time) >= $2)
           AND ($3::timestamptz IS NULL OR start_time <= $3)
         ORDER BY start_time`, [userId, date(from, 'from'), date(to, 'to')]);
    },
    async create(userId, b) {
      await mustExist('users', userId, 'ユーザー');
      const statusId = int(b.status_id, 'status_id', { required: true });
      await mustExist('statuses', statusId, 'ステータス');
      const start = date(b.start_time, 'start_time', { required: true });
      const end = date(b.end_time, 'end_time');
      if (end && new Date(end) <= new Date(start)) throw bad('end_time は start_time より後にしてください');
      const source = b.source ?? 'manual';
      if (!SOURCES.includes(source)) throw bad(`source は ${SOURCES.join('/')} のいずれかです`);
      return one(
        `INSERT INTO user_schedules(user_id, status_id, start_time, end_time, note, source)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [userId, statusId, start, end, str(b.note, 'note', 1000, { required: false }), source]);
    },
    async remove(id) {
      const r = await one('DELETE FROM user_schedules WHERE id=$1 RETURNING id', [id]);
      if (!r) throw notFound('予定が見つかりません');
    },
  };

  // ---------- お気に入り ----------
  const favorites = {
    list: (userId) => q('SELECT favorite_user_id FROM user_favorites WHERE user_id=$1 ORDER BY favorite_user_id', [userId])
      .then((r) => r.map((x) => x.favorite_user_id)),
    async add(userId, favId) {
      if (userId === favId) throw bad('自分自身はお気に入りにできません');
      await mustExist('users', userId, 'ユーザー');
      await mustExist('users', favId, 'お気に入り先ユーザー');
      await q('INSERT INTO user_favorites VALUES($1,$2) ON CONFLICT DO NOTHING', [userId, favId]);
    },
    remove: (userId, favId) => q('DELETE FROM user_favorites WHERE user_id=$1 AND favorite_user_id=$2', [userId, favId]),
  };

  // ---------- 在席ボード ----------
  /**
   * 部署ごとにメンバーと現在ステータス、直近の予定を返す。
   * opts: { departmentId, favoritesOf(userId), q(氏名検索), statusId, now }
   */
  async function board(opts = {}) {
    const now = (opts.now ?? new Date()).toISOString();
    const rows = await q(
      `SELECT u.id, u.name, u.email, u.department_id, u.display_order,
              u.current_status_id, u.status_updated_at, u.status_updated_by,
              p.name AS updated_by_name,
              cur.id AS cur_id, cur.note AS cur_note, cur.start_time AS cur_start, cur.end_time AS cur_end, cur.status_id AS cur_sid,
              nxt.id AS nxt_id, nxt.note AS nxt_note, nxt.start_time AS nxt_start, nxt.end_time AS nxt_end, nxt.status_id AS nxt_sid
         FROM users u
         LEFT JOIN users p ON p.id = u.status_updated_by
         LEFT JOIN LATERAL (SELECT * FROM user_schedules s WHERE s.user_id=u.id AND s.start_time <= $1::timestamptz
                AND (s.end_time IS NULL OR s.end_time > $1::timestamptz) ORDER BY s.start_time DESC LIMIT 1) cur ON TRUE
         LEFT JOIN LATERAL (SELECT * FROM user_schedules s WHERE s.user_id=u.id AND s.start_time > $1::timestamptz
                ORDER BY s.start_time LIMIT 1) nxt ON TRUE
        WHERE ($2::int IS NULL OR u.department_id=$2)
          AND ($3::int IS NULL OR u.id IN (SELECT favorite_user_id FROM user_favorites WHERE user_id=$3))
          AND ($4::text IS NULL OR u.name ILIKE '%' || $4 || '%')
          AND ($5::int IS NULL OR u.current_status_id=$5)
        ORDER BY u.display_order, u.id`,
      [now, int(opts.departmentId), int(opts.favoritesOf), opts.q || null, int(opts.statusId)]);
    const sch = (r, p) => (r[`${p}_id`] == null ? null : {
      id: r[`${p}_id`], status_id: r[`${p}_sid`], note: r[`${p}_note`],
      start_time: r[`${p}_start`], end_time: r[`${p}_end`],
    });
    const members = rows.map((r) => ({
      id: r.id, name: r.name, email: r.email, department_id: r.department_id,
      current_status_id: r.current_status_id, status_updated_at: r.status_updated_at,
      status_updated_by: r.status_updated_by, updated_by_name: r.updated_by_name,
      proxy_updated: r.status_updated_by != null && r.status_updated_by !== r.id,
      current_schedule: sch(r, 'cur'), next_schedule: sch(r, 'nxt'),
    }));
    const depts = await departments.list();
    const groups = depts.map((d) => ({ ...d, members: members.filter((m) => m.department_id === d.id) }));
    const none = members.filter((m) => m.department_id == null);
    if (none.length) groups.push({ id: null, name: '未所属', display_order: 9999, members: none });
    return { departments: groups.filter((g) => g.members.length || (!opts.favoritesOf && !opts.q && !opts.statusId)) };
  }

  /**
   * 行動予定をステータスへ反映(定期実行用)。
   * - 開始済み・未終了の予定があり、予定開始より後に手動更新されていなければ予定のステータスに切替。
   * - 反映済みの予定が終了したら、ステータスを既定(表示順先頭)へ戻す。
   */
  async function applySchedules(now = new Date()) {
    const iso = now.toISOString();
    const def = await one('SELECT id FROM statuses ORDER BY display_order, id LIMIT 1');
    let changed = 0;
    // 開始
    const starts = await q(
      `SELECT u.id AS uid, s.status_id, s.start_time FROM users u
         JOIN LATERAL (SELECT * FROM user_schedules s WHERE s.user_id=u.id AND s.start_time <= $1::timestamptz
              AND (s.end_time IS NULL OR s.end_time > $1::timestamptz) ORDER BY s.start_time DESC LIMIT 1) s ON TRUE
        WHERE (u.status_updated_at IS NULL OR u.status_updated_at < s.start_time)
          AND u.current_status_id IS DISTINCT FROM s.status_id`, [iso]);
    for (const r of starts) {
      await q('UPDATE users SET current_status_id=$2, status_updated_at=$3, status_updated_by=NULL WHERE id=$1',
        [r.uid, r.status_id, iso]);
      changed++;
    }
    // 終了(自動反映された状態=updated_by NULL のまま、予定が終わった人のみ)
    if (def) {
      const ends = await q(
        `SELECT u.id FROM users u
          WHERE u.status_updated_by IS NULL AND u.current_status_id IS DISTINCT FROM $2
            AND NOT EXISTS (SELECT 1 FROM user_schedules s WHERE s.user_id=u.id AND s.start_time <= $1::timestamptz
                 AND (s.end_time IS NULL OR s.end_time > $1::timestamptz))
            AND EXISTS (SELECT 1 FROM user_schedules s WHERE s.user_id=u.id AND s.status_id=u.current_status_id
                 AND s.end_time IS NOT NULL AND s.end_time <= $1::timestamptz AND s.end_time >= u.status_updated_at)`,
        [iso, def.id]);
      for (const r of ends) {
        await q('UPDATE users SET current_status_id=$2, status_updated_at=$3, status_updated_by=NULL WHERE id=$1',
          [r.id, def.id, iso]);
        changed++;
      }
    }
    return changed;
  }

  return { departments, statuses, users, schedules, favorites, board, applySchedules };
}
