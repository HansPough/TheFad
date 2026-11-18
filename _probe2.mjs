import pg from 'pg';
import { config } from './config.js';

const pool = new pg.Pool({ connectionString: config.databaseUrl, options: '-c search_path=thefad,public' });
const q = async (sql, args) => (await pool.query(sql, args)).rows;

try {
  const fns = await q(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result, p.prokind
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'thefad' ORDER BY p.proname`);
  for (const f of fns) console.log(`${f.prokind} ${f.proname}(${f.args}) -> ${f.result}`);

  const imgs = await q(`SELECT count(*)::int AS n, COALESCE(sum(length(image_data)),0)::bigint AS bytes FROM thefad.product_photo`);
  console.log('PHOTOS', JSON.stringify(imgs[0]));
  const cols = await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='thefad' AND table_name='product_photo' ORDER BY ordinal_position`);
  console.log('PHOTO_COLS', cols.map((c) => `${c.column_name}:${c.data_type}`).join(', '));
} catch (error) {
  console.log('FAILED', error.message);
} finally {
  await pool.end();
}
