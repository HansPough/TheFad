/**
 * INVENTORY_LOGS — stock levels and movements. Owner: Rivera.
 * Cashiers may move stock too, so these routes use loginRequired, not roleRequired.
 */
import * as db from '../../db.js';
import { flash } from '../../flash.js';
import { renderPage } from '../../render.js';
import { lowStockDefault } from '../../rules.js';
import { urlFor } from '../../urls.js';
import { toInt, ValidationError } from '../../utils.js';
import { loginRequired } from '../shared/auth.js';

const MOVE_ROUTINES = { in: 'sp_stock_in', out: 'sp_stock_out', adjust: 'sp_adjust_stock' };
const MOVE_LABELS = { in: 'Stock in', out: 'Stock out', adjust: 'Stock count' };
const MOVEMENT_TYPES = ['IN', 'OUT', 'ADJUSTMENT', 'RETURN'];
const MOVEMENT_FILTERS = [
  { value: '', label: 'All movements' },
  { value: 'IN', label: 'Stock in' },
  { value: 'OUT', label: 'Stock out' },
  { value: 'ADJUSTMENT', label: 'Adjustments' },
  { value: 'RETURN', label: 'Returns' },
];
const DATE_RANGES = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
];
const HISTORY_LIMIT = 1000;   // rows fetched for filtering and totals
const PAGE_ROWS = 200;        // rows shown in the table

/** YYYY-MM-DD start date for a date-range choice, or null for "all time". */
function rangeStart(range) {
  const d = new Date();
  if (range === '7d') d.setDate(d.getDate() - 6);
  else if (range === '30d') d.setDate(d.getDate() - 29);
  else if (range === 'month') d.setDate(1);
  else if (range !== 'today') return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * One history row shaped for the movements table.
 * "Boxy Graphic Tee - Black (S)" becomes name "Boxy Graphic Tee" and variant "Black · S".
 */
function shapeMovement(row) {
  const full = String(row.product_name || '');
  const match = /^(.*?) - ([^()]*?)(?: \(([^)]*)\))?$/.exec(full);
  const name = match ? match[1] : full;
  const variant = match ? [match[2], match[3]].filter(Boolean).join(' \u00b7 ') : '';
  const quantity = Number(row.quantity_changed);
  let source = 'Deliveries';
  if (row.transaction_type === 'ADJUSTMENT') source = 'Adjustments';
  else if (row.transaction_type === 'RETURN') source = 'Returns';
  else if (row.transaction_type === 'OUT') source = row.sale_id ? 'Sales' : 'Removals';
  return {
    ...row,
    name,
    variant,
    quantity,
    source,
    added: quantity > 0 ? quantity : null,
    deducted: quantity < 0 ? quantity : null,
    direction: quantity > 0 ? 'in' : 'out',
    badge: quantity > 0 ? 'Stock in' : 'Stock out',
    recorded_by: row.staff_name,
  };
}

/** Low-stock level from the toolbar. Empty means the shop default. */
function readThreshold(value) {
  const text = String(value ?? '').trim();
  if (!text) return lowStockDefault();
  const threshold = toInt(text, 'Low stock level');
  if (threshold < 0) throw new ValidationError('Low stock level cannot be negative.');
  return threshold;
}

/** Quantity for a move: stock in/out need 1 or more; a stock count may be 0. */
function readQuantity(action, value) {
  const quantity = toInt(value, action === 'adjust' ? 'Counted stock' : 'Quantity');
  if (action === 'adjust') {
    if (quantity < 0) throw new ValidationError('Counted stock cannot be negative.');
  } else if (quantity < 1) {
    throw new ValidationError('Quantity must be at least 1.');
  }
  return quantity;
}

export default function register(router) {
  // ---- Stock overview -----------------------------------------------------
  // DB: fn_list_inventory(search, low_only, threshold), fn_list_categories()
  // Note: the 3rd argument is the low-stock threshold, not a row limit.
  router.get('/inventory', 'inventory.index', loginRequired, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '').trim();
    const lowOnly = req.query.low === '1';
    let limit = lowStockDefault();
    try {
      limit = readThreshold(req.query.max);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    let items = [];
    let categories = [];
    try {
      const [rows, cats] = await Promise.all([
        db.callFunction('fn_list_inventory', q || null, lowOnly, limit),
        db.callFunction('fn_list_categories'),
      ]);
      categories = cats.map((row) => row.category_name);
      // fn_list_inventory has no category argument, so filter by name here.
      items = category ? rows.filter((row) => row.category_name === category) : rows;
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return renderPage(req, res, 'inventory.html', {
      items, q, category, categories, limit, low_only: lowOnly,
    });
  });

  // ---- Stock movements (all products) -------------------------------------
  // DB: fn_inventory_history(product_id, limit, type, user_id, start, end), fn_list_inventory()
  // Filters: ?q= search, ?category= name, ?type= IN|OUT|ADJUSTMENT|RETURN, ?range= today|7d|30d|month
  router.get('/inventory/history', 'inventory.history', loginRequired, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const category = String(req.query.category || '').trim();
    const requested = String(req.query.type || '').trim().toUpperCase();
    const range = DATE_RANGES.some((r) => r.value === req.query.range) ? String(req.query.range) : 'all';
    let type = null;
    if (requested) {
      if (MOVEMENT_TYPES.includes(requested)) type = requested;
      else flash(req, 'error', 'Movement type must be IN, OUT, ADJUSTMENT or RETURN.');
    }

    let movements = [];
    let categories = [];
    const stats = { deducted: 0, added: 0, consumption: 0, net: 0 };
    try {
      const [history, cats] = await Promise.all([
        db.callFunction('fn_inventory_history', null, HISTORY_LIMIT, type, null, rangeStart(range), null),
        db.callFunction('fn_list_categories'),
      ]);
      categories = cats.map((row) => row.category_name);

      // History rows carry no category, so look it up from the stock list when needed.
      let categoryById = null;
      if (category) {
        const stock = await db.callFunction('fn_list_inventory', null, false, 0);
        categoryById = new Map(stock.map((row) => [row.product_id, row.category_name]));
      }

      const needle = q.toLowerCase();
      const all = history.map(shapeMovement);
      movements = all.filter((m) => (
        (!category || categoryById.get(m.product_id) === category)
        && (!needle || m.name.toLowerCase().includes(needle)
          || m.variant.toLowerCase().includes(needle)
          || String(m.product_id) === needle)
      ));

      for (const m of movements) {
        if (m.quantity > 0) stats.added += m.quantity;
        else stats.deducted += m.quantity;
      }
      stats.net = stats.added + stats.deducted;
      // "All consumption": everything deducted in this period, across all categories.
      stats.consumption = all.reduce((sum, m) => sum + (m.quantity < 0 ? m.quantity : 0), 0);
    } catch (error) {
      flash(req, 'error', error.message);
    }

    const rows = movements.slice(0, PAGE_ROWS);
    return renderPage(req, res, 'inventory_history.html', {
      rows, total: movements.length, shown: rows.length, stats,
      q, category, categories, type, types: MOVEMENT_FILTERS, range, ranges: DATE_RANGES,
    });
  });

  // ---- One product + its movements ----------------------------------------
  // DB: fn_get_product(product_id), fn_inventory_history(product_id, 50)
  router.get('/inventory/:product_id(\\d+)', 'inventory.item', loginRequired, async (req, res) => {
    const productId = Number(req.params.product_id);
    let product = null;
    let rows = [];
    try {
      product = await db.callFunctionOne('fn_get_product', productId);
      if (!product) throw new ValidationError('That product does not exist.');
      rows = await db.callFunction('fn_inventory_history', productId, 50, null, null, null, null);
    } catch (error) {
      flash(req, 'error', error.message);
      return res.redirect(urlFor('inventory.index'));
    }
    return renderPage(req, res, 'inventory_item.html', { product, rows });
  });

  // ---- Stock in / out / count ---------------------------------------------
  // DB: sp_stock_in | sp_stock_out | sp_adjust_stock (user_id, product_id, quantity, INOUT balance)
  // sp_adjust_stock takes the COUNTED total, not the difference.
  router.post('/inventory/:product_id(\\d+)/move', 'inventory.move', loginRequired, async (req, res) => {
    const productId = Number(req.params.product_id);
    const action = String(req.body.action || '').trim().toLowerCase();
    const routine = MOVE_ROUTINES[action];
    try {
      if (!routine) throw new ValidationError('Choose stock in, stock out or stock count.');
      const quantity = readQuantity(action, req.body.quantity);
      const result = await db.callProcedure(routine, req.session.user_id, productId, quantity, null);
      const balance = result ? result.p_balance : null;
      const suffix = balance === null || balance === undefined ? '' : ` New balance: ${balance}.`;
      flash(req, 'success', `${MOVE_LABELS[action]} saved.${suffix}`);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(urlFor('inventory.item', { product_id: productId }));
  });
}
