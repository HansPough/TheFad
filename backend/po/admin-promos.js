/**
 * DISCOUNT — admin promo manager. Owner: Po.
 * Admin pages require roleRequired('AD'); management POSTs also pass the approval-PIN guard.
 */
import * as db from '../../db.js';
import { flash } from '../../flash.js';
import { renderPage } from '../../render.js';
import { isoDate, shopNow } from '../../time.js';
import { urlFor } from '../../urls.js';
import { toInt, ValidationError } from '../../utils.js';
import { roleRequired } from '../shared/auth.js';

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date as YYYY-MM-DD text, ready for a PostgreSQL date parameter. */
function readDate(value, label) {
  const text = String(value ?? '').trim();
  const date = DATE_TEXT.test(text) ? new Date(`${text}T00:00:00+08:00`) : null;
  if (!date || isoDate(date) !== text) throw new ValidationError(`${label} must be a valid date.`);
  return text;
}

/** One entry per product family (all colors/sizes share the price), for the picker. */
function productFamilies(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (!row.is_active) continue;
    const key = `${row.category_id}||${row.product_name}`;
    if (!seen.has(key)) seen.set(key, { product_id: row.product_id, name: row.product_name });
  }
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** The products the promo is on, grouped by family with their variant count. */
function linkedFamilies(rows, linkedIds) {
  const groups = new Map();
  for (const row of rows) {
    if (!linkedIds.has(row.product_id)) continue;
    const key = `${row.category_id}||${row.product_name}`;
    if (!groups.has(key)) {
      groups.set(key, {
        product_id: row.product_id,
        name: row.product_name,
        base: Number(row.base_price),
        promo: Number(row.current_price),
        variants: 0,
      });
    }
    groups.get(key).variants += 1;
  }
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
}

const missingPromo = (req, res) => {
  flash(req, 'error', 'That promo does not exist.');
  return res.redirect(urlFor('admin_promos.index'));
};

/** The page a management button was clicked on, so an unlink returns there. */
function backTo(req) {
  try {
    const url = new URL(req.get('referer') || '', 'http://local');
    if (url.pathname.startsWith('/admin/promos')) return url.pathname + url.search;
  } catch { /* fall through */ }
  return urlFor('admin_promos.index');
}

/** Add/edit form. `overrides` holds what the admin typed, so a failed save does not lose it. */
async function showPromoForm(req, res, discountId, overrides = {}, status = 200) {
  let products = [];
  let linked = [];
  let promo = {};
  try {
    const rows = await db.callFunction('fn_list_products', null, null, true);
    products = productFamilies(rows);
    if (discountId) {
      promo = await db.callFunctionOne('fn_get_discount', discountId);
      if (!promo) return missingPromo(req, res);
      const onPromo = await db.callFunction('fn_discount_products', discountId);
      linked = linkedFamilies(rows, new Set(onPromo.map((row) => row.product_id)));
    }
  } catch (error) {
    flash(req, 'error', error.message);
  }
  return renderPage(req, res, 'admin/promo_form.html', {
    editing: Boolean(discountId),
    discount_id: discountId,
    today: shopNow(),
    products,
    promo: { ...promo, ...overrides },
    linked,
  }, status);
}

/** Validates the promo fields before the database call. */
function readPromoForm(body) {
  const name = String(body.discount_name || '').trim();
  if (!name) throw new ValidationError('Enter a promo name.');
  const percentage = toInt(body.discount_percentage, 'Discount percent');
  if (percentage < 1 || percentage > 99) throw new ValidationError('Discount must be 1 to 99 percent.');
  const start = readDate(body.start_date, 'Start date');
  const end = readDate(body.end_date, 'End date');
  if (end < start) throw new ValidationError('The end date must be on or after the start date.');
  const scope = String(body.scope || 'NONE').toUpperCase();
  if (!['NONE', 'PRODUCT', 'STORE'].includes(scope)) throw new ValidationError('Choose no products, one product, or the whole store.');
  let productId = null;
  if (scope === 'PRODUCT') {
    const text = String(body.product_id ?? '').trim();
    if (!text) throw new ValidationError('Choose a product.');
    productId = toInt(text, 'Product');
  }
  return { name, percentage, start, end, scope, productId };
}

/** What the admin typed, for re-showing the form after a failed save. */
function enteredPromo(body) {
  return {
    discount_name: String(body.discount_name || '').trim(),
    discount_percentage: String(body.discount_percentage || '').trim(),
    start_date: String(body.start_date || '').trim(),
    end_date: String(body.end_date || '').trim(),
    scope: String(body.scope || 'NONE').toUpperCase(),
    product_id: String(body.product_id ?? '').trim() || null,
  };
}

export default function register(router) {
  // DB: sp_expire_promos(), fn_list_discounts(), fn_discount_product_names(discount_id)
  router.get('/admin/promos', 'admin_promos.index', roleRequired('AD'), async (req, res) => {
    let rows = [];
    try {
      await db.callProcedure('sp_expire_promos', null);
      rows = (await db.callFunction('fn_list_discounts')).map((row) => ({
        ...row, variant_count: Number(row.products_linked) || 0,
      }));
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return renderPage(req, res, 'admin/promos.html', { rows });
  });

  // DB: fn_list_products(null, null, false) for the product picker
  router.get('/admin/promos/new', 'admin_promos.new', roleRequired('AD'),
    (req, res) => showPromoForm(req, res, null));

  // DB: sp_create_discount(...), sp_apply_discount(...)
  router.post('/admin/promos/new', 'admin_promos.new', roleRequired('AD'), async (req, res) => {
    let created;
    try {
      const form = readPromoForm(req.body);
      created = await db.callProcedure(
        'sp_create_discount', form.name, form.percentage, form.start, form.end, form.scope, form.productId, null,
      );
      // Some database versions link only the chosen size/colour on create; apply the promo to the
      // whole product family (or the store) so the result matches the Apply action on the edit page.
      if (form.scope !== 'NONE') {
        await db.callProcedure('sp_apply_discount', created.p_discount_id, form.scope, form.productId, null);
      }
    } catch (error) {
      flash(req, 'error', error.message);
      if (created) return res.redirect(urlFor('admin_promos.view', { discount_id: created.p_discount_id }));
      return showPromoForm(req, res, null, enteredPromo(req.body), 400);
    }
    flash(req, 'success', 'Promo created.');
    return res.redirect(urlFor('admin_promos.view', { discount_id: created.p_discount_id }));
  });

  // DB: fn_get_discount(discount_id), fn_discount_products(discount_id), fn_list_products
  router.get('/admin/promos/:discount_id(\\d+)', 'admin_promos.edit', roleRequired('AD'),
    (req, res) => showPromoForm(req, res, Number(req.params.discount_id)));

  // DB: sp_update_discount(...)
  router.post('/admin/promos/:discount_id(\\d+)', 'admin_promos.edit', roleRequired('AD'), async (req, res) => {
    const discountId = Number(req.params.discount_id);
    try {
      const form = readPromoForm(req.body);
      await db.callProcedure(
        'sp_update_discount', discountId, form.name, form.percentage, form.start, form.end, false, null,
      );
      flash(req, 'success', 'Promo updated.');
      return res.redirect(urlFor('admin_promos.view', { discount_id: discountId }));
    } catch (error) {
      flash(req, 'error', error.message);
      return showPromoForm(req, res, discountId, enteredPromo(req.body), 400);
    }
  });

  // DB: fn_get_discount(discount_id), fn_discount_products(discount_id)
  router.get('/admin/promos/:discount_id(\\d+)/view', 'admin_promos.view', roleRequired('AD'), async (req, res) => {
    const discountId = Number(req.params.discount_id);
    let promo;
    let linked = [];
    try {
      promo = await db.callFunctionOne('fn_get_discount', discountId);
      if (!promo) return missingPromo(req, res);
      const rows = await db.callFunction('fn_list_products', null, null, true);
      const onPromo = await db.callFunction('fn_discount_products', discountId);
      linked = linkedFamilies(rows, new Set(onPromo.map((row) => row.product_id)));
    } catch (error) {
      flash(req, 'error', error.message);
      return res.redirect(urlFor('admin_promos.index'));
    }
    return renderPage(req, res, 'admin/promo_detail.html', { promo, linked });
  });

  // DB: sp_update_discount(...) with the end date set to now
  router.post('/admin/promos/:discount_id(\\d+)/end', 'admin_promos.end_now', roleRequired('AD'), async (req, res) => {
    try {
      await db.callProcedure('sp_update_discount', Number(req.params.discount_id), null, null, null, null, true, null);
      flash(req, 'success', 'Promo ended. Prices are back to normal.');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(urlFor('admin_promos.index'));
  });

  // DB: sp_apply_discount(discount_id, scope, product_id)
  router.post('/admin/promos/:discount_id(\\d+)/apply', 'admin_promos.apply', roleRequired('AD'), async (req, res) => {
    const discountId = Number(req.params.discount_id);
    try {
      const scope = String(req.body.scope || '').toUpperCase();
      if (!['PRODUCT', 'STORE'].includes(scope)) throw new ValidationError('Choose one product or the whole store.');
      let productId = null;
      if (scope === 'PRODUCT') {
        const text = String(req.body.product_id ?? '').trim();
        if (!text) throw new ValidationError('Choose a product.');
        productId = toInt(text, 'Product');
      }
      const applied = await db.callProcedure('sp_apply_discount', discountId, scope, productId, null);
      flash(req, 'success', `Promo applied to ${applied.p_products_updated} item${applied.p_products_updated === 1 ? '' : 's'}.`);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(urlFor('admin_promos.edit', { discount_id: discountId }));
  });

  // DB: sp_clear_product_discount(product_id)
  router.post('/admin/promos/unlink/:product_id(\\d+)', 'admin_promos.unlink', roleRequired('AD'), async (req, res) => {
    try {
      await db.callProcedure('sp_clear_product_discount', Number(req.params.product_id));
      flash(req, 'success', 'Product removed from the promo.');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(backTo(req));
  });

  // DB: sp_delete_unused_discount(discount_id)
  router.post('/admin/promos/:discount_id(\\d+)/delete', 'admin_promos.delete_unused', roleRequired('AD'), async (req, res) => {
    try {
      await db.callProcedure('sp_delete_unused_discount', Number(req.params.discount_id));
      flash(req, 'success', 'Promo deleted.');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(urlFor('admin_promos.index'));
  });
}
