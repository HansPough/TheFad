/**
 * UI preview — runs the real templates against preview/fixtures.json.
 *
 *     npm run preview
 *
 * No database, no stored routines, no sign-in: every screen renders from the snapshot in
 * fixtures.json and the sample sessions below. Changes made while the preview runs (cart,
 * stock, order status, attendance, promos) live in memory and reset when it stops.
 *
 * This file is a demo harness only. The real app is still `npm start` with backend/*.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../app.js';
import { flash } from '../flash.js';
import { renderPage } from '../render.js';
import { addDays, isoDate, isoTime, shopNow, startOfShopDay } from '../time.js';
import * as data from './data.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const DEMO_PASSWORD_HINT = 'Demo accounts: dev_admin (Admin@1234) or dev_cashier (Cashier@1234). Any password works here.';

const fullName = (person) => `${person.first_name || ''} ${person.last_name || ''}`.trim() || person.username;
const personById = (id) => data.state.staff.find((person) => person.user_id === Number(id)) || null;
const nextId = (rows, key) => Math.max(0, ...rows.map((row) => Number(row[key]) || 0)) + 1;

function resetSession(req) {
  for (const key of Object.keys(req.session)) {
    if (key !== 'cookie') delete req.session[key];
  }
}

function startSession(req, person) {
  resetSession(req);
  req.session.user_id = person.user_id;
  req.session.username = person.username;
  req.session.user_type = person.user_type;
  req.session.display_name = fullName(person);
}

function currentPerson(req) {
  return personById(req.session.user_id) || null;
}

// ------------------------------------------------------------------ demo sessions

function demoBeforeRoutes(req, res, next) {
  if (!req.session.user_id && !req.session.demoSignedOut) {
    const admin = personById(data.ids.admin_id) || data.state.staff[0];
    if (admin) startSession(req, admin);
  }
  if (req.session.user_id) {
    req.staffAccess = {
      active: true,
      allowed: true,
      can_clock_in: true,
      user_type: req.session.user_type,
      schedule: null,
    };
  }
  next();
}

function signedIn(req, res, next) {
  if (req.session.user_id) return next();
  flash(req, 'info', 'Sign in to continue.');
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function adminOnly(req, res, next) {
  return signedIn(req, res, () => {
    if (req.session.user_type === 'AD') return next();
    return renderPage(req, res, 'error.html', {
      code: 403,
      heading: 'You do not have access to this page',
      message: 'This page is for admins. Ask an admin if you need it.',
    }, 403);
  });
}

const safeNext = (target) => Boolean(target) && target.startsWith('/') && !target.startsWith('//') && !String(target).includes('\\');

function backTo(req, fallback) {
  const referer = req.get('referer');
  if (referer) {
    try {
      const url = new URL(referer);
      return `${url.pathname}${url.search}`;
    } catch { /* use the fallback */ }
  }
  return fallback;
}

function missing(req, res, message, fallback) {
  flash(req, 'error', message);
  return res.redirect(fallback);
}

// ------------------------------------------------------------------ shared mutations

function categoryName(categoryId) {
  const category = data.categories.find((row) => row.category_id === Number(categoryId));
  return category ? category.category_name : '';
}

function promoStatus(start, end, now = shopNow()) {
  const from = startOfShopDay(start).getTime();
  const until = startOfShopDay(end).getTime() + 24 * 3600 * 1000;
  if (now.getTime() < from) return 'Upcoming';
  if (now.getTime() >= until) return 'Ended';
  return 'Active';
}

function linkedProductsFor(scope, productId, existing = []) {
  if (scope === 'STORE') {
    const seen = new Map();
    for (const row of data.state.products.filter((product) => product.is_active !== false)) {
      const key = `${row.category_name}||${row.product_name}`;
      if (!seen.has(key)) {
        seen.set(key, {
          product_id: row.product_id,
          product_name: row.product_name,
          base_price: Number(row.base_price) || 0,
          current_price: Number(row.current_price) || 0,
          variants: 0,
        });
      }
      seen.get(key).variants += 1;
    }
    return [...seen.values()];
  }
  if (scope === 'PRODUCT') {
    const row = data.state.products.find((product) => product.product_id === Number(productId));
    if (!row) return existing;
    const merged = existing.filter((entry) => entry.product_id !== row.product_id);
    merged.push({
      product_id: row.product_id,
      product_name: row.product_name,
      base_price: Number(row.base_price) || 0,
      current_price: Number(row.current_price) || 0,
      variants: data.state.products.filter((product) => product.product_name === row.product_name
        && product.category_name === row.category_name).length,
    });
    return merged;
  }
  return existing;
}

function syncPromoRow(record, discount) {
  const linked = record.linked || [];
  const variants = linked.reduce((sum, entry) => sum + (Number(entry.variants) || 0), 0);
  discount.products_linked = String(variants);
  discount.variant_count = variants;
  discount.linked_products = linked.map((entry) => entry.product_name).join(', ');
}

function syncMyOvertime(req) {
  data.fixtures.my_overtime = (data.fixtures.overtime || [])
    .filter((permit) => permit.user_id === req.session.user_id);
}

function seedDemoData() {
  const admin = personById(data.ids.admin_id);
  const now = shopNow();

  if (admin && !(data.fixtures.overtime || []).length) {
    const permit = {
      permit_id: nextId(data.state.overtime, 'permit_id'),
      user_id: admin.user_id,
      full_name: fullName(admin),
      work_date: now,
      start_time: isoTime(new Date(now.getTime() - 60 * 60000)),
      end_time: isoTime(new Date(now.getTime() + 180 * 60000)),
      grace_minutes: 15,
      note: 'Closing count (demo overtime)',
      status: 'Allowed',
      time_in: null,
      time_out: null,
      hours_worked: null,
    };
    data.fixtures.overtime.push(permit);
    data.fixtures.permits[String(permit.permit_id)] = permit;
    data.state.overtime.push({ ...permit });
  }

  if (!data.state.sales.some((sale) => sale.order_status === 'Pending')) {
    const product = data.state.products.find((row) => row.is_active !== false && row.current_stock > 0);
    if (product) {
      const saleId = data.nextSaleId();
      const price = Number(product.current_price) || 0;
      const sale = {
        sale_id: saleId,
        user_id: data.ids.cashier_id,
        cashier: fullName(personById(data.ids.cashier_id)),
        sale_date: new Date(now.getTime() - 30 * 60000),
        fulfillment_type: 'Delivery',
        customer_name: 'Demo Customer',
        customer_contact: '0917 000 0000',
        delivery_address: 'Lapu-Lapu City, Cebu',
        subtotal: price,
        discount_amount: 0,
        total_amount: price,
        payment_method: 'GCash',
        order_status: 'Pending',
        rider_service: null,
        rider_contact: null,
        item_count: 1,
      };
      data.state.sales.unshift(sale);
      data.fixtures.sale_details[String(saleId)] = {
        sale: { ...sale },
        items: [{
          item_id: nextId(data.fixtures.movements, 'log_id') + 1000,
          product_id: product.product_id,
          product_name: product.display_name || product.product_name,
          quantity: 1,
          base_price: price,
          unit_price_at_sale: price,
          line_total: price,
          discount_name: null,
          quantity_refunded: 0,
        }],
      };
    }
  }
}

seedDemoData();

// ------------------------------------------------------------------ routes

function register(router) {
  // ---------------------------------------------------------------- shop (public)
  router.get('/', 'catalog.index', (req, res) => renderPage(req, res, 'catalog.html', data.catalog(req.query)));

  router.get('/search-suggestions', 'catalog.suggestions', (req, res) => res.json(data.suggestions(req.query)));

  router.get('/product/:product_id(\\d+)', 'catalog.product', (req, res) => {
    const locals = data.productPage(req.params.product_id, req.query);
    if (!locals) return missing(req, res, 'That product is not in the demo data.', '/');
    return renderPage(req, res, 'product.html', locals);
  });

  router.get('/media/product/:image_id(\\d+)', 'catalog.product_image', (req, res) => {
    const file = data.imageFor(req.params.image_id);
    if (!file) return res.type('image/svg+xml').send(data.placeholderSvg(req.params.image_id));
    return res.sendFile(file);
  });

  // ---------------------------------------------------------------- sign-in
  router.get('/staff', 'auth.staff', (req, res) => res.redirect(req.session.user_id ? '/dashboard' : '/login'));

  router.get('/login', 'auth.login', (req, res) => {
    if (req.session.user_id) return res.redirect('/dashboard');
    flash(req, 'info', DEMO_PASSWORD_HINT);
    return renderPage(req, res, 'login.html', { next: String(req.query.next || ''), username: '' });
  });

  router.post('/login', 'auth.login', (req, res) => {
    const next = String(req.body.next || '');
    const username = String(req.body.username || '').trim();
    const person = data.state.staff.find((row) => row.username === username);
    if (!username || !String(req.body.password || '')) {
      flash(req, 'error', 'Enter both your username and password.');
      return renderPage(req, res, 'login.html', { next, username }, 400);
    }
    if (!person || person.is_active === false) {
      flash(req, 'error', `No active demo account called "${username}". ${DEMO_PASSWORD_HINT}`);
      return renderPage(req, res, 'login.html', { next, username }, 401);
    }
    startSession(req, person);
    flash(req, 'success', `Signed in as ${fullName(person)} (preview).`);
    return res.redirect(safeNext(next) ? next : '/dashboard');
  });

  router.get('/verify-otp', 'auth.verify_otp', (req, res) => res.redirect(req.session.user_id ? '/dashboard' : '/login'));

  router.post('/logout', 'auth.logout', (req, res) => {
    resetSession(req);
    req.session.demoSignedOut = true;
    flash(req, 'info', 'Signed out. ' + DEMO_PASSWORD_HINT);
    return res.redirect('/login');
  });

  router.get('/account', 'auth.account', adminOnly, (req, res) => renderPage(req, res, 'account.html', {}));

  router.post('/account', 'auth.account', adminOnly, (req, res) => {
    flash(req, 'success', 'Approval PIN saved (preview only — nothing is stored).');
    return res.redirect('/account');
  });

  // ---------------------------------------------------------------- dashboard
  router.get('/dashboard', 'dashboard.index', signedIn, (req, res) => renderPage(req, res, 'dashboard.html', data.dashboard()));

  // ---------------------------------------------------------------- point of sale
  const cartOf = (req) => {
    if (!req.session.cart) req.session.cart = {};
    return req.session.cart;
  };
  const posUrl = (body) => {
    const params = new URLSearchParams();
    if (body.q) params.set('q', String(body.q));
    if (body.category) params.set('category', String(body.category));
    const query = params.toString();
    return `/pos/${query ? `?${query}` : ''}`;
  };

  router.get('/pos', 'pos.index', signedIn, (req, res) => {
    return renderPage(req, res, 'pos.html', data.posPage(req.query, cartOf(req)));
  });

  router.post('/pos/cart/add', 'pos.add', signedIn, (req, res) => {
    const product = data.cartProduct(req.body.product_id);
    const quantity = Math.max(1, Math.trunc(Number(req.body.quantity) || 1));
    if (!product) {
      flash(req, 'error', 'That item is not in the demo catalog.');
      return res.redirect(posUrl(req.body));
    }
    const cart = cartOf(req);
    const next = Math.min(product.current_stock, (Number(cart[product.product_id]) || 0) + quantity);
    if (next <= 0) {
      flash(req, 'error', `${product.display_name || product.product_name} is out of stock.`);
    } else {
      cart[product.product_id] = next;
      flash(req, 'success', `Added ${product.display_name || product.product_name} to the cart.`);
    }
    return res.redirect(posUrl(req.body));
  });

  router.post('/pos/cart/update', 'pos.update', signedIn, (req, res) => {
    const product = data.cartProduct(req.body.product_id);
    const cart = cartOf(req);
    if (!product) return res.redirect(posUrl(req.body));
    const key = String(product.product_id);
    let quantity = Number(cart[key]) || 0;
    if (req.body.quantity !== undefined && req.body.quantity !== '') {
      quantity = Math.trunc(Number(req.body.quantity) || 0);
    } else {
      quantity += Math.trunc(Number(req.body.delta) || 0);
    }
    quantity = Math.min(product.current_stock, Math.max(0, quantity));
    if (quantity <= 0) delete cart[key];
    else cart[key] = quantity;
    return res.redirect(posUrl(req.body));
  });

  router.post('/pos/cart/clear', 'pos.clear', signedIn, (req, res) => {
    delete req.session.cart;
    flash(req, 'info', 'Cart cleared.');
    return res.redirect(posUrl(req.body));
  });

  router.post('/pos/checkout', 'pos.checkout', signedIn, (req, res) => {
    const cart = cartOf(req);
    if (!data.cartLines(cart).length) {
      flash(req, 'error', 'The cart is empty. Add an item before completing the sale.');
      return res.redirect(posUrl(req.body));
    }
    if (req.body.fulfillment_type === 'Delivery' && !String(req.body.customer_name || '').trim()) {
      flash(req, 'error', 'A delivery order needs a customer name.');
      return res.redirect(posUrl(req.body));
    }
    const person = currentPerson(req);
    const sale = data.checkout(cart, req.body, person);
    delete req.session.cart;
    flash(req, 'success', `Sale #${sale.sale_id} completed.`);
    return res.redirect(`/orders/${sale.sale_id}`);
  });

  // ---------------------------------------------------------------- orders
  router.get('/orders', 'orders.index', signedIn, (req, res) => renderPage(req, res, 'orders.html', data.ordersPage(req.query)));

  router.get('/orders/:sale_id(\\d+)', 'orders.detail', signedIn, (req, res) => {
    const found = data.saleFor(req.params.sale_id);
    if (!found) return missing(req, res, 'That order is not in the demo data.', '/orders/');
    return renderPage(req, res, 'order_detail.html', found);
  });

  router.post('/orders/:sale_id(\\d+)/status', 'orders.set_status', signedIn, (req, res) => {
    const status = String(req.body.new_status || '');
    const sale = data.setOrderStatus(req.params.sale_id, status, req.body);
    if (!sale) return missing(req, res, 'That order is not in the demo data.', '/orders/');
    flash(req, 'success', `Order #${sale.sale_id} marked ${status.replaceAll('_', ' ').toLowerCase()}.`);
    return res.redirect(`/orders/${sale.sale_id}`);
  });

  // ---------------------------------------------------------------- inventory
  router.get('/inventory', 'inventory.index', signedIn, (req, res) => renderPage(req, res, 'inventory.html', data.inventoryPage(req.query)));

  router.get('/inventory/history', 'inventory.history', signedIn, (req, res) => renderPage(req, res, 'inventory_history.html', {
    rows: [...data.state.movements].sort((left, right) => right.logged_at - left.logged_at),
  }));

  router.get('/inventory/:product_id(\\d+)', 'inventory.item', signedIn, (req, res) => {
    const locals = data.inventoryItemPage(req.params.product_id);
    if (!locals) return missing(req, res, 'That product is not in the demo data.', '/inventory/');
    return renderPage(req, res, 'inventory_item.html', locals);
  });

  router.post('/inventory/:product_id(\\d+)/move', 'inventory.move', signedIn, (req, res) => {
    const product = data.moveStock(req.params.product_id, String(req.body.action || ''), req.body.quantity, currentPerson(req));
    if (!product) return missing(req, res, 'That product is not in the demo data.', '/inventory/');
    flash(req, 'success', `Stock updated — ${product.display_name || product.product_name} now has ${product.current_stock}.`);
    return res.redirect(`/inventory/${product.product_id}`);
  });

  // ---------------------------------------------------------------- attendance
  router.get('/attendance', 'attendance.index', signedIn, (req, res) => {
    syncMyOvertime(req);
    return renderPage(req, res, 'attendance.html', data.attendanceMine());
  });

  router.post('/attendance/clock-in', 'attendance.clock_in', signedIn, (req, res) => {
    const before = data.attendanceMine();
    if (before.open_row || before.today_done) {
      flash(req, 'info', before.open_row ? 'You are already on shift.' : 'Your shift is already finished for today.');
      return res.redirect('/attendance/');
    }
    data.clockIn(currentPerson(req));
    flash(req, 'success', 'Clocked in.');
    return res.redirect('/attendance/');
  });

  router.post('/attendance/clock-out', 'attendance.clock_out', signedIn, (req, res) => {
    const closed = data.clockOut();
    flash(req, closed ? 'success' : 'info', closed ? 'Clocked out.' : 'There is no open shift.');
    return res.redirect('/attendance/');
  });

  router.post('/attendance/overtime-in', 'attendance.overtime_in', signedIn, (req, res) => {
    syncMyOvertime(req);
    const permit = (data.fixtures.my_overtime || [])[0];
    if (!permit) {
      flash(req, 'error', 'No approved overtime for today.');
      return res.redirect('/attendance/');
    }
    if (!permit.time_in) permit.time_in = shopNow();
    permit.status = 'In progress';
    const mirror = data.state.overtime.find((row) => row.permit_id === permit.permit_id);
    if (mirror) Object.assign(mirror, { time_in: permit.time_in, status: permit.status });
    flash(req, 'success', 'Overtime started.');
    return res.redirect('/attendance/');
  });

  router.post('/attendance/overtime-out', 'attendance.overtime_out', signedIn, (req, res) => {
    syncMyOvertime(req);
    const permit = (data.fixtures.my_overtime || [])[0];
    if (!permit || !permit.time_in) {
      flash(req, 'error', 'Overtime has not started.');
      return res.redirect('/attendance/');
    }
    permit.time_out = shopNow();
    permit.hours_worked = Math.round(((permit.time_out - permit.time_in) / 3600000) * 100) / 100;
    permit.status = 'Done';
    const mirror = data.state.overtime.find((row) => row.permit_id === permit.permit_id);
    if (mirror) Object.assign(mirror, { time_out: permit.time_out, hours_worked: permit.hours_worked, status: permit.status });
    flash(req, 'success', 'Overtime ended.');
    return res.redirect('/attendance/');
  });

  router.get('/attendance/everyone', 'attendance.everyone', adminOnly, (req, res) => renderPage(req, res, 'attendance_everyone.html', data.attendanceEveryone(req.query)));

  router.get('/attendance/shift', 'attendance.new_shift', adminOnly, (req, res) => {
    const locals = data.shiftFormPage(null);
    if (req.query.user_id) locals.shift.user_id = Number(req.query.user_id);
    return renderPage(req, res, 'shift_form.html', locals);
  });

  const saveShift = (req, dtrId) => {
    const person = personById(req.body.user_id);
    if (!person) return false;
    const now = shopNow();
    const timeIn = new Date(String(req.body.time_in).length <= 16 ? `${req.body.time_in}:00+08:00` : `${req.body.time_in}+08:00`);
    const timeOut = new Date(String(req.body.time_out).length <= 16 ? `${req.body.time_out}:00+08:00` : `${req.body.time_out}+08:00`);
    if (Number.isNaN(timeIn.getTime()) || Number.isNaN(timeOut.getTime()) || timeOut <= timeIn) return false;
    const setting = data.fixtures.shift_setting || {};
    const start = new Date(`${isoDate(timeIn)}T${String(setting.shift_start || '09:00:00').slice(0, 8)}+08:00`);
    const graceMs = (Number(setting.grace_minutes) || 0) * 60000;
    const record = {
      dtr_id: dtrId ? Number(dtrId) : nextId(data.fixtures.attendance_board.filter((row) => row.dtr_id), 'dtr_id'),
      user_id: person.user_id,
      shift_type: 'Regular',
      time_in: timeIn,
      time_out: timeOut,
      total_hours: Math.round(((timeOut - timeIn) / 3600000) * 100) / 100,
      overtime_hours: 0,
      status: timeIn.getTime() > start.getTime() + graceMs ? 'Late' : 'Present',
      note: String(req.body.note || '') || null,
    };
    data.fixtures.shifts[String(record.dtr_id)] = record;
    data.fixtures.attendance_board = data.fixtures.attendance_board
      .filter((row) => row.dtr_id !== record.dtr_id);
    data.fixtures.attendance_board.push({
      ...record,
      full_name: fullName(person),
      work_day: startOfShopDay(timeIn),
    });
    data.fixtures.attendance_board.sort((left, right) => right.work_day - left.work_day);
    return record;
  };

  router.post('/attendance/shift', 'attendance.new_shift', adminOnly, (req, res) => {
    const record = saveShift(req, null);
    flash(req, record ? 'success' : 'error', record ? 'Shift saved.' : 'Choose a staff member and valid times.');
    return res.redirect(record ? '/attendance/everyone' : '/attendance/shift');
  });

  router.get('/attendance/shift/:dtr_id(\\d+)', 'attendance.edit_shift', adminOnly, (req, res) => {
    return renderPage(req, res, 'shift_form.html', data.shiftFormPage(req.params.dtr_id));
  });

  router.post('/attendance/shift/:dtr_id(\\d+)', 'attendance.edit_shift', adminOnly, (req, res) => {
    const record = saveShift(req, req.params.dtr_id);
    flash(req, record ? 'success' : 'error', record ? 'Shift updated.' : 'Choose a staff member and valid times.');
    return res.redirect(record ? '/attendance/everyone' : `/attendance/shift/${req.params.dtr_id}`);
  });

  router.get('/attendance/overtime', 'attendance.overtime', adminOnly, (req, res) => renderPage(req, res, 'overtime.html', data.overtimePage(req.query)));

  router.get('/attendance/overtime/new', 'attendance.new_overtime', adminOnly, (req, res) => {
    return renderPage(req, res, 'overtime_form.html', data.overtimeFormPage(null));
  });

  const saveOvertime = (req, permitId) => {
    const person = personById(req.body.user_id);
    if (!person || !req.body.work_date || !req.body.start_time || !req.body.end_time) return null;
    const existing = permitId ? data.fixtures.permits[String(permitId)] : null;
    const record = {
      ...(existing || {}),
      permit_id: permitId ? Number(permitId) : nextId(data.fixtures.overtime, 'permit_id'),
      user_id: person.user_id,
      full_name: fullName(person),
      work_date: new Date(`${String(req.body.work_date).slice(0, 10)}T00:00:00+08:00`),
      start_time: String(req.body.start_time),
      end_time: String(req.body.end_time),
      grace_minutes: Number(req.body.grace_minutes) || 0,
      note: String(req.body.note || '') || null,
      status: existing?.status && existing.status !== 'Allowed' ? existing.status : 'Allowed',
      time_in: existing?.time_in || null,
      time_out: existing?.time_out || null,
      hours_worked: existing?.hours_worked ?? null,
    };
    data.fixtures.permits[String(record.permit_id)] = record;
    const index = data.fixtures.overtime.findIndex((row) => row.permit_id === record.permit_id);
    if (index >= 0) data.fixtures.overtime[index] = record;
    else data.fixtures.overtime.push(record);
    const mirrorIndex = data.state.overtime.findIndex((row) => row.permit_id === record.permit_id);
    if (mirrorIndex >= 0) data.state.overtime[mirrorIndex] = { ...record };
    else data.state.overtime.push({ ...record });
    return record;
  };

  router.post('/attendance/overtime/new', 'attendance.new_overtime', adminOnly, (req, res) => {
    const record = saveOvertime(req, null);
    flash(req, record ? 'success' : 'error', record ? 'Overtime allowed.' : 'Choose a staff member, date and times.');
    return res.redirect(record ? '/attendance/overtime' : '/attendance/overtime/new');
  });

  router.get('/attendance/overtime/:permit_id(\\d+)', 'attendance.edit_overtime', adminOnly, (req, res) => {
    return renderPage(req, res, 'overtime_form.html', data.overtimeFormPage(req.params.permit_id));
  });

  router.post('/attendance/overtime/:permit_id(\\d+)', 'attendance.edit_overtime', adminOnly, (req, res) => {
    const record = saveOvertime(req, req.params.permit_id);
    flash(req, record ? 'success' : 'error', record ? 'Overtime updated.' : 'Choose a staff member, date and times.');
    return res.redirect(record ? '/attendance/overtime' : `/attendance/overtime/${req.params.permit_id}`);
  });

  router.post('/attendance/overtime/:permit_id(\\d+)/cancel', 'attendance.cancel_overtime', adminOnly, (req, res) => {
    const id = Number(req.params.permit_id);
    data.fixtures.overtime = data.fixtures.overtime.filter((row) => row.permit_id !== id);
    data.state.overtime = data.state.overtime.filter((row) => row.permit_id !== id);
    delete data.fixtures.permits[String(id)];
    flash(req, 'success', 'Overtime cancelled.');
    return res.redirect('/attendance/overtime');
  });

  router.get('/attendance/schedule', 'attendance.schedule', adminOnly, (req, res) => renderPage(req, res, 'schedule.html', data.schedulePage()));

  router.post('/attendance/schedule', 'attendance.schedule', adminOnly, (req, res) => {
    data.fixtures.shift_setting = {
      ...(data.fixtures.shift_setting || {}),
      shift_start: `${String(req.body.shift_start || '09:00').slice(0, 5)}:00`,
      shift_end: `${String(req.body.shift_end || '17:00').slice(0, 5)}:00`,
      grace_minutes: Number(req.body.grace_minutes) || 0,
    };
    flash(req, 'success', 'Schedule saved (preview only).');
    return res.redirect('/attendance/schedule');
  });

  // ---------------------------------------------------------------- promos
  router.get('/promos', 'promos.index', signedIn, (req, res) => renderPage(req, res, 'promos.html', data.promosPage()));

  router.get('/admin/promos', 'admin_promos.index', adminOnly, (req, res) => {
    const locals = data.adminPromosPage();
    locals.rows = locals.rows.map((row) => ({
      ...row,
      variant_count: Number(row.variant_count ?? row.products_linked) || 0,
    }));
    return renderPage(req, res, 'admin/promos.html', locals);
  });

  router.get('/admin/promos/new', 'admin_promos.new', adminOnly, (req, res) => renderPage(req, res, 'admin/promo_form.html', data.promoFormPage(null)));

  const savePromo = (req, discountId) => {
    const name = String(req.body.discount_name || '').trim();
    const percentage = Number(req.body.discount_percentage);
    if (!name || !Number.isFinite(percentage) || percentage < 1 || percentage > 99) return null;
    const start = new Date(`${String(req.body.start_date).slice(0, 10)}T00:00:00+08:00`);
    const end = new Date(`${String(req.body.end_date).slice(0, 10)}T00:00:00+08:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;

    const id = discountId ? Number(discountId) : nextId(data.state.discounts, 'discount_id');
    const status = promoStatus(start, end);
    const existingRecord = data.fixtures.promos[String(id)];
    const record = existingRecord || { promo: {}, linked: [], linkedNames: [] };
    record.promo = {
      ...(record.promo || {}),
      discount_id: id,
      discount_name: name,
      discount_percentage: percentage,
      start_date: start,
      end_date: end,
      status,
    };
    data.fixtures.promos[String(id)] = record;

    let discount = data.state.discounts.find((row) => row.discount_id === id);
    if (!discount) {
      discount = {
        discount_id: id,
        discount_name: name,
        discount_percentage: percentage,
        start_date: start,
        end_date: end,
        status,
        products_linked: '0',
        linked_products: '',
      };
      data.state.discounts.push(discount);
    } else {
      Object.assign(discount, { discount_name: name, discount_percentage: percentage, start_date: start, end_date: end, status });
    }

    if (!discountId && req.body.scope && req.body.scope !== 'NONE') {
      record.linked = linkedProductsFor(req.body.scope, req.body.product_id, record.linked);
    }
    syncPromoRow(record, discount);
    return record.promo;
  };

  router.post('/admin/promos/new', 'admin_promos.new', adminOnly, (req, res) => {
    const promo = savePromo(req, null);
    flash(req, promo ? 'success' : 'error', promo ? 'Promo created.' : 'Check the promo name, percent and dates.');
    return res.redirect(promo ? `/admin/promos/${promo.discount_id}/view` : '/admin/promos/new');
  });

  router.get('/admin/promos/:discount_id(\\d+)', 'admin_promos.edit', adminOnly, (req, res) => {
    const locals = data.promoFormPage(req.params.discount_id);
    return renderPage(req, res, 'admin/promo_form.html', locals);
  });

  router.post('/admin/promos/:discount_id(\\d+)', 'admin_promos.edit', adminOnly, (req, res) => {
    const promo = savePromo(req, req.params.discount_id);
    flash(req, promo ? 'success' : 'error', promo ? 'Promo updated.' : 'Check the promo name, percent and dates.');
    return res.redirect(promo ? `/admin/promos/${promo.discount_id}/view` : `/admin/promos/${req.params.discount_id}`);
  });

  router.get('/admin/promos/:discount_id(\\d+)/view', 'admin_promos.view', adminOnly, (req, res) => {
    const locals = data.promoViewPage(req.params.discount_id);
    if (!locals) return missing(req, res, 'That promo is not in the demo data.', '/admin/promos/');
    return renderPage(req, res, 'admin/promo_detail.html', locals);
  });

  router.post('/admin/promos/:discount_id(\\d+)/end', 'admin_promos.end_now', adminOnly, (req, res) => {
    const discount = data.endPromo(req.params.discount_id);
    if (!discount) return missing(req, res, 'That promo is not in the demo data.', '/admin/promos/');
    const record = data.fixtures.promos[String(discount.discount_id)];
    if (record) {
      record.promo.status = 'Ended';
      record.promo.end_date = startOfShopDay(shopNow());
    }
    flash(req, 'success', `"${discount.discount_name}" ended.`);
    return res.redirect('/admin/promos/');
  });

  router.post('/admin/promos/:discount_id(\\d+)/apply', 'admin_promos.apply', adminOnly, (req, res) => {
    const id = Number(req.params.discount_id);
    const record = data.fixtures.promos[String(id)];
    if (!record) return missing(req, res, 'That promo is not in the demo data.', '/admin/promos/');
    record.linked = linkedProductsFor(req.body.scope, req.body.product_id, record.linked || []);
    const discount = data.state.discounts.find((row) => row.discount_id === id);
    if (discount) syncPromoRow(record, discount);
    flash(req, 'success', 'Promo applied to the selected products.');
    return res.redirect(`/admin/promos/${id}`);
  });

  router.post('/admin/promos/unlink/:product_id(\\d+)', 'admin_promos.unlink', adminOnly, (req, res) => {
    const productId = Number(req.params.product_id);
    for (const record of Object.values(data.fixtures.promos)) {
      record.linked = (record.linked || []).filter((entry) => entry.product_id !== productId);
      const discount = data.state.discounts.find((row) => row.discount_id === record.promo?.discount_id);
      if (discount) syncPromoRow(record, discount);
    }
    flash(req, 'success', 'Product removed from the promo.');
    return res.redirect(backTo(req, '/admin/promos/'));
  });

  router.post('/admin/promos/:discount_id(\\d+)/delete', 'admin_promos.delete_unused', adminOnly, (req, res) => {
    const id = Number(req.params.discount_id);
    const before = data.state.discounts.length;
    data.state.discounts = data.state.discounts.filter((row) => row.discount_id !== id);
    delete data.fixtures.promos[String(id)];
    flash(req, before === data.state.discounts.length ? 'error' : 'success',
      before === data.state.discounts.length ? 'That promo is not in the demo data.' : 'Promo deleted.');
    return res.redirect('/admin/promos/');
  });

  // ---------------------------------------------------------------- refunds
  router.get('/admin/refunds', 'refunds.index', adminOnly, (req, res) => renderPage(req, res, 'admin/refunds.html', data.refundsPage(req.query)));

  router.get('/admin/refunds/find', 'refunds.find', adminOnly, (req, res) => {
    const saleId = Number(req.query.sale_id);
    if (!saleId || !data.saleFor(saleId)) {
      flash(req, 'error', 'Enter an order number that exists in the demo data.');
      return res.redirect('/admin/refunds/');
    }
    return res.redirect(`/admin/refunds/sale/${saleId}`);
  });

  router.get('/admin/refunds/sale/:sale_id(\\d+)', 'refunds.sale', adminOnly, (req, res) => {
    const locals = data.refundSalePage(req.params.sale_id);
    if (!locals) return missing(req, res, 'That order is not in the demo data.', '/admin/refunds/');
    return renderPage(req, res, 'admin/refund_sale.html', locals);
  });

  router.post('/admin/refunds/sale/:sale_id(\\d+)', 'refunds.sale', adminOnly, (req, res) => {
    const saleId = Number(req.params.sale_id);
    const detail = data.fixtures.sale_details[String(saleId)];
    const item = detail?.items?.find((row) => row.item_id === Number(req.body.item_id));
    const sale = data.state.sales.find((row) => row.sale_id === saleId);
    if (!detail || !item || !sale) {
      flash(req, 'error', 'That order or item is not in the demo data.');
      return res.redirect('/admin/refunds/');
    }
    const left = Number(item.quantity) - (Number(item.quantity_refunded) || 0);
    const quantity = Math.min(left, Math.max(1, Math.trunc(Number(req.body.quantity) || 1)));
    if (left <= 0) {
      flash(req, 'info', 'That item is already fully refunded.');
      return res.redirect(`/admin/refunds/sale/${saleId}`);
    }
    item.quantity_refunded = (Number(item.quantity_refunded) || 0) + quantity;
    const amount = quantity * Number(item.unit_price_at_sale);
    data.fixtures.refunds.unshift({
      refund_id: nextId(data.fixtures.refunds, 'refund_id'),
      refund_date: shopNow(),
      sale_id: saleId,
      product_name: item.product_name,
      quantity_refunded: quantity,
      refund_amount: amount,
      refund_method: req.body.method || 'Cash',
      reason: String(req.body.reason || '') || null,
      processed_by: fullName(currentPerson(req)),
    });
    const fully = detail.items.every((row) => Number(row.quantity_refunded) >= Number(row.quantity));
    sale.order_status = fully ? 'Refunded' : 'Partially_Refunded';
    flash(req, 'success', `Refunded ${quantity} × ${item.product_name}.`);
    return res.redirect(`/admin/refunds/sale/${saleId}`);
  });

  router.get('/admin/audit', 'audit.index', adminOnly, (req, res) => renderPage(req, res, 'audit.html', data.auditPage(req.query)));

  // ---------------------------------------------------------------- admin: products
  router.get('/admin/products', 'admin_products.index', adminOnly, (req, res) => renderPage(req, res, 'admin/products.html', data.adminProductsPage(req.query)));

  router.get('/admin/products/new', 'admin_products.new', adminOnly, (req, res) => renderPage(req, res, 'admin/product_form.html', data.productFormPage(null)));

  const productRow = (fields, color, size) => {
    const base = Number(fields.base_price) || 0;
    const name = String(fields.product_name || '').trim();
    return {
      product_id: nextId(data.state.products, 'product_id'),
      product_name: name,
      color: String(color || '').trim() || null,
      size: String(size || '').trim() || null,
      display_name: `${name}${color ? ` - ${color}` : ''}${size ? ` (${size})` : ''}`,
      description: String(fields.description || '').trim() || null,
      image_id: null,
      base_price: base,
      current_price: base,
      current_stock: 0,
      category_id: Number(fields.category_id),
      category_name: categoryName(fields.category_id),
      discount_name: null,
      discount_percentage: null,
      is_active: true,
    };
  };

  router.post('/admin/products/new', 'admin_products.new', adminOnly, (req, res) => {
    if (!String(req.body.product_name || '').trim() || !Number(req.body.base_price)) {
      flash(req, 'error', 'A product needs a name and a price.');
      return res.redirect('/admin/products/new');
    }
    const colors = String(req.body.colors || '').split(',').map((value) => value.trim()).filter(Boolean);
    const sizes = String(req.body.sizes || '').split(',').map((value) => value.trim()).filter(Boolean);
    const combos = [];
    if (!colors.length && !sizes.length) combos.push(['', '']);
    else for (const color of (colors.length ? colors : [''])) {
      for (const size of (sizes.length ? sizes : [''])) combos.push([color, size]);
    }
    const created = [];
    for (const [color, size] of combos) {
      const row = productRow(req.body, color, size);
      data.state.products.push(row);
      created.push(row);
    }
    data.fixtures.variants[String(created[0].product_id)] = created.map((row) => ({
      product_id: row.product_id,
      color: row.color,
      size: row.size,
      base_price: row.base_price,
      current_price: row.current_price,
      current_stock: row.current_stock,
      is_active: row.is_active,
      image_id: row.image_id,
    }));
    flash(req, 'success', `Added ${created[0].product_name}.`);
    return res.redirect('/admin/products/');
  });

  const groupRows = (product) => data.state.products.filter((row) => row.category_name === product.category_name
    && row.product_name === product.product_name);

  router.get('/admin/products/:product_id(\\d+)/edit', 'admin_products.edit', adminOnly, (req, res) => renderPage(req, res, 'admin/product_form.html', data.productFormPage(req.params.product_id)));

  router.post('/admin/products/:product_id(\\d+)/edit', 'admin_products.edit', adminOnly, (req, res) => {
    const product = data.state.products.find((row) => row.product_id === Number(req.params.product_id));
    if (!product) return missing(req, res, 'That product is not in the demo data.', '/admin/products/');
    const targets = req.body.apply_all ? groupRows(product) : [product];
    for (const row of targets) {
      row.product_name = String(req.body.product_name || row.product_name).trim();
      row.description = String(req.body.description || '').trim() || null;
      row.base_price = Number(req.body.base_price) || row.base_price;
      row.current_price = row.base_price;
      row.category_id = Number(req.body.category_id) || row.category_id;
      row.category_name = categoryName(row.category_id);
      row.display_name = `${row.product_name}${row.color ? ` - ${row.color}` : ''}${row.size ? ` (${row.size})` : ''}`;
    }
    product.color = String(req.body.color || '').trim() || null;
    product.size = String(req.body.size || '').trim() || null;
    product.display_name = `${product.product_name}${product.color ? ` - ${product.color}` : ''}${product.size ? ` (${product.size})` : ''}`;
    flash(req, 'success', 'Product saved (preview only).');
    return res.redirect('/admin/products/');
  });

  router.get('/admin/products/:product_id(\\d+)/photos', 'admin_products.photos', adminOnly, (req, res) => {
    const locals = data.photosPage(req.params.product_id);
    if (!locals) return missing(req, res, 'That product is not in the demo data.', '/admin/products/');
    return renderPage(req, res, 'admin/product_photos.html', locals);
  });

  router.post('/admin/products/:product_id(\\d+)/photos/upload', 'admin_products.upload_photos', adminOnly, (req, res) => {
    flash(req, 'success', 'Photos are not stored in the preview. The form flow works.');
    return res.redirect(`/admin/products/${req.params.product_id}/photos`);
  });

  router.post('/admin/products/:product_id(\\d+)/photos/:image_id(\\d+)/remove', 'admin_products.remove_photo', adminOnly, (req, res) => {
    flash(req, 'success', 'Photo removed (preview only).');
    return res.redirect(`/admin/products/${req.params.product_id}/photos`);
  });

  router.post('/admin/products/:product_id(\\d+)/photos/:image_id(\\d+)/cover', 'admin_products.cover_photo', adminOnly, (req, res) => {
    flash(req, 'success', 'Cover photo changed (preview only).');
    return res.redirect(`/admin/products/${req.params.product_id}/photos`);
  });

  router.post('/admin/products/:product_id(\\d+)/add-variant', 'admin_products.add_variant', adminOnly, (req, res) => {
    const product = data.state.products.find((row) => row.product_id === Number(req.params.product_id));
    if (!product) return missing(req, res, 'That product is not in the demo data.', '/admin/products/');
    if (!String(req.body.color || '').trim() && !String(req.body.size || '').trim()) {
      flash(req, 'error', 'Enter a color or a size to add.');
      return res.redirect(`/admin/products/${product.product_id}/edit`);
    }
    const row = {
      ...product,
      product_id: nextId(data.state.products, 'product_id'),
      color: String(req.body.color || '').trim() || null,
      size: String(req.body.size || '').trim() || null,
      current_stock: 0,
      image_id: null,
      is_active: true,
    };
    row.display_name = `${row.product_name}${row.color ? ` - ${row.color}` : ''}${row.size ? ` (${row.size})` : ''}`;
    data.state.products.push(row);
    const key = String(product.product_id);
    if (!data.fixtures.variants[key]) data.fixtures.variants[key] = [];
    data.fixtures.variants[key].push({
      product_id: row.product_id,
      color: row.color,
      size: row.size,
      base_price: row.base_price,
      current_price: row.current_price,
      current_stock: row.current_stock,
      is_active: row.is_active,
      image_id: row.image_id,
    });
    flash(req, 'success', 'Color/size added.');
    return res.redirect(`/admin/products/${product.product_id}/edit`);
  });

  router.post('/admin/products/:product_id(\\d+)/active', 'admin_products.set_active', adminOnly, (req, res) => {
    const product = data.state.products.find((row) => row.product_id === Number(req.params.product_id));
    if (!product) return missing(req, res, 'That product is not in the demo data.', '/admin/products/');
    product.is_active = String(req.body.active) === '1';
    flash(req, 'success', product.is_active ? 'Product reactivated.' : 'Product deactivated.');
    return res.redirect(backTo(req, '/admin/products/'));
  });

  // ---------------------------------------------------------------- admin: categories
  router.get('/admin/products/categories', 'admin_products.categories', adminOnly, (req, res) => renderPage(req, res, 'admin/categories.html', data.categoriesPage()));

  router.post('/admin/products/categories', 'admin_products.categories', adminOnly, (req, res) => {
    const name = String(req.body.category_name || '').trim();
    if (!name) {
      flash(req, 'error', 'Enter a category name.');
      return res.redirect('/admin/products/categories');
    }
    const row = {
      category_id: nextId(data.categories, 'category_id'),
      category_name: name,
      display_order: Number(req.body.display_order) || 0,
      product_count: 0,
    };
    data.categories.push(row);
    data.fixtures.categories.push(row);
    flash(req, 'success', `Category "${name}" added.`);
    return res.redirect('/admin/products/categories');
  });

  router.post('/admin/products/categories/:category_id(\\d+)', 'admin_products.update_category', adminOnly, (req, res) => {
    const id = Number(req.params.category_id);
    const category = data.categories.find((row) => row.category_id === id);
    if (!category) return missing(req, res, 'That category is not in the demo data.', '/admin/products/categories');
    category.category_name = String(req.body.category_name || category.category_name).trim();
    category.display_order = Number(req.body.display_order) || 0;
    for (const product of data.state.products.filter((row) => row.category_id === id)) {
      product.category_name = category.category_name;
    }
    flash(req, 'success', 'Category updated.');
    return res.redirect('/admin/products/categories');
  });

  router.post('/admin/products/categories/:category_id(\\d+)/delete', 'admin_products.delete_category', adminOnly, (req, res) => {
    const id = Number(req.params.category_id);
    if (data.state.products.some((row) => row.category_id === id)) {
      flash(req, 'error', 'A category that still holds products cannot be deleted.');
      return res.redirect('/admin/products/categories');
    }
    const before = data.categories.length;
    data.categories = data.categories.filter((row) => row.category_id !== id);
    data.fixtures.categories = data.fixtures.categories.filter((row) => row.category_id !== id);
    flash(req, before === data.categories.length ? 'error' : 'success',
      before === data.categories.length ? 'That category is not in the demo data.' : 'Category deleted.');
    return res.redirect('/admin/products/categories');
  });

  // ---------------------------------------------------------------- admin: staff
  router.get('/admin/staff', 'admin_staff.index', adminOnly, (req, res) => renderPage(req, res, 'admin/staff.html', data.staffPage()));

  router.get('/admin/staff/new', 'admin_staff.new', adminOnly, (req, res) => renderPage(req, res, 'admin/staff_form.html', data.staffFormPage(null)));

  const staffFields = (req, person) => {
    person.username = String(req.body.username || person.username).trim();
    person.email = String(req.body.email || '').trim() || null;
    person.first_name = String(req.body.first_name || person.first_name).trim();
    person.last_name = String(req.body.last_name || person.last_name).trim();
    person.user_type = req.body.user_type === 'AD' ? 'AD' : (req.body.user_type === 'CA' ? 'CA' : person.user_type);
    person.station = String(req.body.station || '').trim() || null;
    if (req.body.hired_on) person.hired_on = new Date(`${String(req.body.hired_on).slice(0, 10)}T00:00:00+08:00`);
    return person;
  };

  router.post('/admin/staff/new', 'admin_staff.new', adminOnly, (req, res) => {
    if (!String(req.body.username || '').trim() || !String(req.body.first_name || '').trim()
      || !String(req.body.last_name || '').trim() || String(req.body.password || '').length < 8) {
      flash(req, 'error', 'Fill in the name, username and a password of 8 or more characters.');
      return res.redirect('/admin/staff/new');
    }
    if (data.state.staff.some((row) => row.username === String(req.body.username).trim())) {
      flash(req, 'error', 'That username is already taken.');
      return res.redirect('/admin/staff/new');
    }
    const person = {
      user_id: nextId(data.state.staff, 'user_id'),
      username: '',
      first_name: '',
      last_name: '',
      user_type: 'CA',
      station: null,
      email: null,
      is_active: true,
      clocked_in: false,
      hired_on: shopNow(),
    };
    staffFields(req, person);
    data.state.staff.push(person);
    data.fixtures.staff.push(person);
    flash(req, 'success', `${fullName(person)} added.`);
    return res.redirect('/admin/staff/');
  });

  router.get('/admin/staff/:user_id(\\d+)/edit', 'admin_staff.edit', adminOnly, (req, res) => renderPage(req, res, 'admin/staff_form.html', data.staffFormPage(req.params.user_id)));

  router.post('/admin/staff/:user_id(\\d+)/edit', 'admin_staff.edit', adminOnly, (req, res) => {
    const person = personById(req.params.user_id);
    if (!person) return missing(req, res, 'That staff member is not in the demo data.', '/admin/staff/');
    staffFields(req, person);
    flash(req, 'success', 'Staff account updated.');
    return res.redirect('/admin/staff/');
  });

  router.post('/admin/staff/:user_id(\\d+)/active', 'admin_staff.set_active', adminOnly, (req, res) => {
    const person = personById(req.params.user_id);
    if (!person) return missing(req, res, 'That staff member is not in the demo data.', '/admin/staff/');
    person.is_active = String(req.body.active) === '1';
    flash(req, 'success', person.is_active ? 'Account reactivated.' : 'Account deactivated.');
    return res.redirect('/admin/staff/');
  });

  // ---------------------------------------------------------------- demo helpers
  router.get('/preview/role/:type', 'preview.role', (req, res) => {
    const wanted = String(req.params.type).toUpperCase() === 'CA' ? 'CA' : 'AD';
    const person = data.state.staff.find((row) => row.user_type === wanted && row.is_active !== false);
    if (person) startSession(req, person);
    flash(req, 'info', `Previewing as ${person ? fullName(person) : 'admin'} (${wanted === 'AD' ? 'Admin' : 'Cashier'}).`);
    return res.redirect('/dashboard');
  });

  router.get('/preview/reset', 'preview.reset', (req, res) => {
    data.resetState();
    delete req.session.cart;
    flash(req, 'success', 'Preview data reset to the sample snapshot.');
    return res.redirect(backTo(req, '/dashboard'));
  });
}

// ------------------------------------------------------------------ server

const app = createApp({
  register,
  staticOverlay: path.join(here, 'static'),
  beforeRoutes: demoBeforeRoutes,
  approval: null,
  health: (req, res) => res.json({ preview: 'ok', data: path.join('preview', 'fixtures.json') }),
});

const port = Number(process.env.PREVIEW_PORT || 5001);
const host = process.env.PREVIEW_HOST || '127.0.0.1';

app.listen(port, host, () => {
  console.log(`The Fad preview (no database) is running at http://${host}:${port}`);
  console.log('Signed in as dev_admin. Use /preview/role/CA for the cashier menu, /preview/role/AD for admin.');
  console.log('Sample data lives in preview/fixtures.json; changes reset when this process stops.');
});
