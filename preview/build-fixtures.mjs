/**
 * Builds the sample data the UI preview runs on.
 *
 * Run this only when the database is available; it is the one step of the preview that needs it:
 *
 *     npm run preview:fixtures
 *
 * It reads the real stored functions, exactly as a finished handler would, and writes
 * preview/fixtures.json plus a downscaled copy of every product photo in preview/images/.
 * After that `npm run preview` works with the database stopped.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import pg from 'pg';

import { config } from '../config.js';
import { addDays, isoDate, shopNow } from '../time.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const imageDir = path.join(here, 'images');
const temporary = path.join(here, '.photo-source');

const today = shopNow();
const start60 = isoDate(addDays(today, -60));
const start30 = isoDate(addDays(today, -30));
const end = isoDate(today);
const workDays = '1,2,3,4,5,6';
const LOW = 5;

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 4,
  options: `-c search_path=${config.dbSchema},public`,
});

const rows = async (sql, args = []) => (await pool.query(sql, args)).rows;
const fn = (name, ...args) => rows(
  `SELECT * FROM ${config.dbSchema}.${name}(${args.map((_, index) => `$${index + 1}`).join(', ')})`,
  args,
);
const one = async (name, ...args) => (await fn(name, ...args))[0] || null;

/**
 * Dates must stay the shop-local Date objects the templates format; JSON has no dates, so this turns
 * every date-only string into the same instant the database layer would have produced.
 */
function clean(value) {
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clean(entry)]));
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00+08:00`);
  }
  return value;
}

/** Copies the rows for one colour/size group: variants, photo list and the ids of its photos. */
async function readGroups(products) {
  const firstIds = new Map();
  for (const product of products) {
    const key = `${product.category_name}||${product.product_name}`;
    if (!firstIds.has(key)) firstIds.set(key, product.product_id);
  }
  const variants = {};
  const photos = {};
  const imageIds = new Set();
  for (const productId of firstIds.values()) {
    variants[String(productId)] = await fn('fn_list_variants', productId);
    const gallery = await fn('fn_list_product_photos', productId);
    photos[String(productId)] = gallery;
    for (const photo of gallery) imageIds.add(photo.image_id);
  }
  return { variants, photos, imageIds: [...imageIds] };
}

/**
 * Photos live in the database as full-size PNG/JPEG. The preview only needs them small, so they are
 * converted with Pillow when it is installed; without Pillow the preview simply shows its drawn
 * placeholders instead (every screen still works).
 */
async function writePhotos(client, imageIds) {
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.rm(imageDir, { recursive: true, force: true });
  if (!imageIds.length) return {};

  const { rows: images } = await client.query(
    `SELECT image_id, image_data FROM ${config.dbSchema}.product_image WHERE image_id = ANY($1::int[])`,
    [imageIds],
  );
  await fs.mkdir(temporary, { recursive: true });
  for (const image of images) {
    await fs.writeFile(path.join(temporary, `${image.image_id}.src`), image.image_data);
  }

  const script = path.join(here, 'tools', 'resize_photos.py');
  for (const python of ['python', 'py', 'python3']) {
    try {
      await run(python, [script, temporary, imageDir], { timeout: 180000 });
      const files = await fs.readdir(imageDir);
      const map = {};
      for (const file of files) {
        const match = /^(\d+)\.jpg$/.exec(file);
        if (match) map[match[1]] = file;
      }
      await fs.rm(temporary, { recursive: true, force: true });
      return map;
    } catch {
      // No Python, no Pillow, or a conversion error: fall through to the next interpreter.
    }
  }
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.rm(imageDir, { recursive: true, force: true });
  console.warn('Pillow was not available, so the preview will draw placeholder photos instead.');
  return {};
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');                      // read-only pass; nothing is written back

    const categories = await fn('fn_list_categories');
    const products = await fn('fn_list_products', null, null, true);
    const inventory = await fn('fn_list_inventory', null, false, LOW);
    const movements = await fn('fn_inventory_history', null, 200);
    const staff = await fn('fn_list_staff');
    const sales = await fn('fn_list_sales', start60, end, null);
    const board = await fn('fn_attendance_board', start30, end, null, workDays);
    const overtime = await fn('fn_list_overtime', start30, end);
    const discounts = await fn('fn_list_discounts');
    const refunds = await fn('fn_list_refunds', start60, end);
    const refundReport = await fn('fn_refund_report', start60, end);
    const audit = await fn('fn_audit_logs', start30, end, null, null, null, 0);

    const admin = staff.find((person) => person.user_type === 'AD') || staff[0];
    const cashier = staff.find((person) => person.user_type === 'CA') || admin;
    const busiest = sales.find((sale) => sale.item_count > 1) || sales[0];

    const saleDetails = {};
    for (const sale of sales.slice(0, 12)) {
      saleDetails[String(sale.sale_id)] = {
        sale: await one('fn_get_sale', sale.sale_id),
        items: await fn('fn_sale_items', sale.sale_id),
      };
    }

    const myAttendance = await fn('fn_my_attendance', admin.user_id, 30);
    const shifts = {};
    for (const row of board.filter((entry) => entry.dtr_id).slice(0, 10)) {
      shifts[String(row.dtr_id)] = await one('fn_get_shift', row.dtr_id);
    }

    const permits = {};
    for (const permit of overtime.slice(0, 10)) {
      permits[String(permit.permit_id)] = await one('fn_get_overtime', permit.permit_id);
    }

    const promos = {};
    for (const discount of discounts) {
      promos[String(discount.discount_id)] = {
        promo: await one('fn_get_discount', discount.discount_id),
        linked: await fn('fn_discount_products', discount.discount_id),
        linkedNames: await fn('fn_discount_product_names', discount.discount_id),
      };
    }

    const { variants, photos, imageIds } = await readGroups(products);
    const imageFiles = await writePhotos(client, imageIds);

    const fixtures = clean({
      generated_at: new Date().toISOString(),
      source: { low_stock: LOW },
      ids: {
        admin_id: admin.user_id,
        cashier_id: cashier.user_id,
        sale_id: busiest ? busiest.sale_id : null,
        product_id: products[0] ? products[0].product_id : null,
        dtr_id: board.find((entry) => entry.dtr_id)?.dtr_id ?? null,
        permit_id: overtime[0] ? overtime[0].permit_id : null,
        discount_id: discounts[0] ? discounts[0].discount_id : null,
        user_id: staff[1] ? staff[1].user_id : admin.user_id,
      },
      admin,
      cashier,
      categories,
      products,
      inventory,
      movements,
      dashboard: {
        summary: await one('fn_dashboard_summary', LOW),
        days: await fn('fn_sales_by_day', 7),
        top: await fn('fn_top_products', 7, 5),
      },
      staff,
      sales,
      sale_details: saleDetails,
      my_attendance: myAttendance,
      attendance_board: board,
      overtime,
      shifts,
      permits,
      shift_setting: await one('fn_get_shift_setting'),
      discounts,
      promos,
      refunds,
      refund_report: refundReport,
      audit,
      variants,
      photos,
      image_files: imageFiles,
      range: { start30, start60, end, work_days: workDays },
    });

    await fs.writeFile(path.join(here, 'fixtures.json'), `${JSON.stringify(fixtures, null, 1)}\n`);
    await client.query('ROLLBACK');

    console.log(`Wrote preview/fixtures.json — ${categories.length} categories, ${products.length} products, `
      + `${sales.length} sales, ${staff.length} staff, ${Object.keys(promos).length} promos, ${audit.length} audit events.`);
    console.log(Object.keys(imageFiles).length
      ? `Wrote ${Object.keys(imageFiles).length} product photos to preview/images/.`
      : 'No product photos were written.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Could not build the preview fixtures:', error.message);
  console.error('Only this step needs the THEFAD database; npm run preview itself does not.');
  process.exitCode = 1;
});
