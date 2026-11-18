import pg from 'pg';
import { config } from './config.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl, options: "-c search_path=thefad,public" });
try {
  const tables = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'thefad' ORDER BY table_name`);
  console.log('TABLES', tables.rows.map((r) => r.table_name).join(', '));
  for (const name of ['PRODUCT', 'CATEGORY', 'USERS', 'SALES', 'SALE_ITEM', 'DISCOUNT', 'REFUND', 'INVENTORY_LOGS', 'DAILY_TIME_RECORD', 'PRODUCT_PHOTOS', 'AUDIT_LOG']) {
    try {
      const c = await pool.query(`SELECT count(*)::int AS n FROM thefad.${name}`);
      console.log(`COUNT ${name} ${c.rows[0].n}`);
    } catch (e) {
      console.log(`COUNT ${name} ERR ${e.message}`);
    }
  }
} catch (error) {
  console.log('CONNECT_FAILED', error.message);
} finally {
  await pool.end();
}
