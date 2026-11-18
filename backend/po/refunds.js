/**
 * REFUND — refund report and processing. Owner: Po.
 */
import * as db from '../../db.js';
import { flash } from '../../flash.js';
import { renderPage } from '../../render.js';
import { addDays, isoDate, parseTimestamp, shopNow } from '../../time.js';
import { urlFor } from '../../urls.js';
import { toInt, ValidationError } from '../../utils.js';
import { roleRequired } from '../shared/auth.js';

const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

function readDate(value, label) {
  const text = String(value ?? '').trim();
  const date = DATE_TEXT.test(text) ? new Date(`${text}T00:00:00+08:00`) : null;
  if (!date || isoDate(date) !== text) throw new ValidationError(`${label} must be a valid date.`);
  return text;
}

/** The reporting window: the query string when valid, otherwise the last 30 days. */
function readRange(req) {
  const today = shopNow();
  let startText = isoDate(addDays(today, -30));
  let endText = isoDate(today);
  try {
    if (req.query.start) startText = readDate(req.query.start, 'Start date');
    if (req.query.end) endText = readDate(req.query.end, 'End date');
    if (endText < startText) throw new ValidationError('The end date must be on or after the start date.');
  } catch (error) {
    flash(req, 'error', error.message);
    startText = isoDate(addDays(today, -30));
    endText = isoDate(today);
  }
  return { startText, endText, start: parseTimestamp(startText), end: parseTimestamp(endText) };
}

export default function register(router) {
  // DB: fn_refund_report(start, end), fn_list_refunds(start, end)
  router.get('/admin/refunds', 'refunds.index', roleRequired('AD'), async (req, res) => {
    const { startText, endText, start, end } = readRange(req);
    let report = [];
    let refunds = [];
    try {
      report = await db.callFunction('fn_refund_report', startText, endText);
      refunds = await db.callFunction('fn_list_refunds', startText, endText);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return renderPage(req, res, 'admin/refunds.html', { start, end, report, refunds });
  });

  // Reads ?sale_id= and redirects to the refund page; no database call.
  router.get('/admin/refunds/find', 'refunds.find', roleRequired('AD'), (req, res) => {
    const text = String(req.query.sale_id ?? '').trim();
    if (!/^\d{1,9}$/.test(text) || Number(text) === 0) {
      flash(req, 'error', 'Enter a valid order number.');
      return res.redirect(urlFor('refunds.index'));
    }
    return res.redirect(urlFor('refunds.sale', { sale_id: Number(text) }));
  });

  // DB: fn_get_sale(sale_id), fn_sale_items(sale_id)
  router.get('/admin/refunds/sale/:sale_id(\\d+)', 'refunds.sale', roleRequired('AD'), async (req, res) => {
    const saleId = Number(req.params.sale_id);
    let sale;
    let items = [];
    try {
      sale = await db.callFunctionOne('fn_get_sale', saleId);
      if (sale) items = await db.callFunction('fn_sale_items', saleId);
    } catch (error) {
      flash(req, 'error', error.message);
      return res.redirect(urlFor('refunds.index'));
    }
    if (!sale) {
      flash(req, 'error', 'That order does not exist.');
      return res.redirect(urlFor('refunds.index'));
    }
    return renderPage(req, res, 'admin/refund_sale.html', {
      sale,
      items,
      can_refund: ['Completed', 'Partially_Refunded'].includes(sale.order_status),
    });
  });

  // DB: sp_process_refund(user_id, sale_id, item_id, quantity, reason, method)
  router.post('/admin/refunds/sale/:sale_id(\\d+)', 'refunds.sale', roleRequired('AD'), async (req, res) => {
    const saleId = Number(req.params.sale_id);
    try {
      const itemId = toInt(req.body.item_id, 'Item');
      const quantity = toInt(req.body.quantity, 'Quantity');
      if (quantity < 1) throw new ValidationError('Refund at least one unit.');
      const method = String(req.body.method || '');
      if (!['Cash', 'GCash'].includes(method)) throw new ValidationError('Choose Cash or GCash for the refund.');
      const reason = String(req.body.reason || '').trim();
      await db.callProcedure(
        'sp_process_refund', req.session.user_id, saleId, itemId, quantity, reason || null, method, null,
      );
      flash(req, 'success', `Refunded ${quantity} unit${quantity === 1 ? '' : 's'}. Stock is back in inventory.`);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(urlFor('refunds.sale', { sale_id: saleId }));
  });
}
