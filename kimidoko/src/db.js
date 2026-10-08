import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');

/**
 * DB 接続。DATABASE_URL があれば PostgreSQL、無ければ組込み PGlite(インメモリ/ディレクトリ永続)。
 * 戻り値は { query(sql, params) -> {rows}, close() } 。
 */
export async function createDb({ url = process.env.DATABASE_URL, dataDir = process.env.PGLITE_DIR } = {}) {
  let db;
  if (url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url });
    await pool.query(SCHEMA);
    db = { query: (s, p) => pool.query(s, p), close: () => pool.end() };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = dataDir ? new PGlite(dataDir) : new PGlite();
    await lite.exec(SCHEMA);
    db = { query: (s, p) => lite.query(s, p), close: () => lite.close() };
  }
  return db;
}
