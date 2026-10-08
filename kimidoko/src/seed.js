const STATUSES = [
  ['在席', '#2E9E5B', '🟢'], ['外出', '#E8A33D', '🚶'], ['会議中', '#D9534F', '👥'], ['テレワーク', '#4A90E2', '🏠'],
  ['出張', '#8E5BD0', '✈️'], ['休暇', '#8A8F98', '🌴'], ['退社', '#555B66', '🌙'],
];
const DEPTS = ['営業部', '開発部', '総務部'];
const PEOPLE = [
  ['山田 太郎', 0], ['佐藤 花子', 0], ['鈴木 一郎', 1], ['高橋 美咲', 1], ['田中 健', 1], ['伊藤 涼', 2],
];

/** 初期データ(DB が空のときのみ)。 */
export async function seed(db) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  const sIds = [];
  for (const [i, [name, color, icon]] of STATUSES.entries()) {
    const r = await db.query('INSERT INTO statuses(name,color_code,icon_url,display_order) VALUES($1,$2,$3,$4) RETURNING id', [name, color, icon, i]);
    sIds.push(r.rows[0].id);
  }
  const dIds = [];
  for (const [i, name] of DEPTS.entries()) {
    dIds.push((await db.query('INSERT INTO departments(name,display_order) VALUES($1,$2) RETURNING id', [name, i])).rows[0].id);
  }
  for (const [i, [name, d]] of PEOPLE.entries()) {
    await db.query(
      'INSERT INTO users(department_id,name,email,current_status_id,status_updated_at,display_order) VALUES($1,$2,$3,$4,now(),$5)',
      [dIds[d], name, `user${i + 1}@example.com`, sIds[0], i]);
  }
}
