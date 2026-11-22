import * as db from '../../db.js';
import { flash } from '../../flash.js';
import { renderPage } from '../../render.js';
import { loginRequired } from '../shared/auth.js';
import { toInt } from '../../utils.js';

const ORDER_STATUSES = ['Pending', 'Out_for_Delivery', 'Completed', 'Cancelled'];
const NON_SALE_STATUSES = new Set(['Cancelled', 'Refunded']);

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function defaultRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start: isoDate(start), end: isoDate(end) };
}

export default function register(router) {
  router.get('/orders', 'orders.index', loginRequired, async (req, res) => {
    const range = defaultRange();
    const start = req.query.start || range.start;
    const end = req.query.end || range.end;
    const status = req.query.status || null;
    
    let rows = [];
    try {
      rows = await db.callFunction('fn_list_sales', start, end, status);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    
    // fixed: order_status instead of status
    const total = rows
      .filter((o) => !NON_SALE_STATUSES.has(o.order_status))
      .reduce((sum, o) => sum + Number(o.total_amount ?? 0), 0);
      
    return renderPage(req, res, 'orders.html', {
      rows: rows,              // fixed: orders.html uses "rows"
      start,
      end,
      status,
      total,
      statuses: ORDER_STATUSES, // fixed: orders.html uses "statuses"
    });
  });

  router.get('/orders/:sale_id(\\d+)', 'orders.detail', loginRequired, async (req, res) => {
    const saleId = toInt(req.params.sale_id, null);
    if (!saleId) {
      flash(req, 'error', 'Invalid order id.');
      return res.redirect('/orders');
    }
    let sale = null;
    let items = [];
    try {
      sale = await db.callFunctionOne('fn_get_sale', saleId);
      if (sale) items = await db.callFunction('fn_sale_items', saleId);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    if (!sale) {
      flash(req, 'error', `Order #${saleId} not found.`);
      return res.redirect('/orders');
    }
    return renderPage(req, res, 'order_detail.html', {
      sale,
      items,
      statuses: ORDER_STATUSES,
    });
  });

    router.post('/orders/:sale_id(\\d+)/status', 'orders.set_status', loginRequired, async (req, res) => {
    const saleId = toInt(req.params.sale_id, null);
    const newStatus = String(req.body.new_status || req.body.status || '').trim(); 
    
    if (!saleId || !ORDER_STATUSES.includes(newStatus)) {
      flash(req, 'error', 'Pick a valid order status.');
      return res.redirect(saleId ? `/orders/${saleId}` : '/orders');
    }
    
    // Combine driver name and rider service for the DB
    const driverName = String(req.body.driver_name || '').trim();
    const riderServiceRaw = String(req.body.rider_service || '').trim();
    let riderService = riderServiceRaw;
    if (driverName && riderServiceRaw) {
        riderService = `${driverName} - ${riderServiceRaw}`;
    } else if (driverName) {
        riderService = driverName;
    }
    riderService = riderService || null;
    
    const riderContact = String(req.body.rider_contact || '').trim() || null;

    try {
      // fixed: Removed the 6th 'null' argument, this procedure has NO INOUT
      await db.callProcedure(
        'sp_update_order_status',
        req.session.user_id,
        saleId,
        newStatus,
        riderService,
        riderContact
      );
      flash(req, 'success', 'Order status updated.');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(`/orders/${saleId}`);
  });


}