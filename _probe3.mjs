import pg from 'pg';
import { config } from './config.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl, options: '-c search_path=thefad,public' });
const q = async (sql, args) => (await pool.query(sql, args)).rows;

try {
  for (const t of ['product_photo', 'product_image', 'product', 'sales', 'refund', 'discount', 'change_audit', 'category', 'users', 'overtime_permit', 'daily_time_record']) {
    const cols = await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='thefad' AND table_name=$1 ORDER BY ordinal_position`, [t]);
    console.log(`\n${t}: ${cols.map((c) => `${c.column_name}:${c.data_type}`).join(', ')}`);
  }
  console.log('\nPHOTO_SIZES', JSON.stringify((await q('SELECT count(*)::int n, coalesce(sum(length(photo_data)),0)::bigint bytes FROM thefad.product_photo'))[0]));
} catch (error) {
  console.log('FAILED', error.message);
} finally {
  await pool.end();
}
