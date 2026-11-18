import pg from 'pg';
import { config } from './config.js';
const pool = new pg.Pool({ connectionString: config.databaseUrl, options: '-c search_path=thefad,public' });
for (const t of ['overtime_permit','shift_setting','management_pin']) {
  const r = await pool.query(`SELECT count(*)::int n FROM thefad.${t}`);
  console.log(t, r.rows[0].n);
}
const b = await pool.query(`SELECT status, count(*)::int n FROM thefad.daily_time_record GROUP BY status`);
console.log('DTR statuses', JSON.stringify(b.rows));
const s = await pool.query(`SELECT order_status, count(*)::int n FROM thefad.sales GROUP BY order_status`);
console.log('sale statuses', JSON.stringify(s.rows));
await pool.end();
