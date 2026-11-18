import pg from 'pg';
import { config } from './config.js';
const pool = new pg.Pool({ connectionString: config.databaseUrl, options: '-c search_path=thefad,public' });
const r = await pool.query(`SELECT count(*)::int AS images, coalesce(sum(length(image_data)),0)::bigint AS bytes, coalesce(max(length(image_data)),0)::int AS biggest FROM thefad.product_image`);
console.log(JSON.stringify(r.rows[0]));
const m = await pool.query(`SELECT mime_type, count(*)::int AS n FROM thefad.product_image GROUP BY mime_type`);
console.log(JSON.stringify(m.rows));
await pool.end();
