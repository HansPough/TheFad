/**
 * Sample data for the UI preview.
 *
 * `preview/fixtures.json` is a snapshot of the real database taken with `npm run preview:fixtures`.
 * This file turns that snapshot into exactly the locals each template asks for, so every screen can
 * be opened without a database, without a route handler and without signing in.
 *
 * Nothing here is imported by the real app: `preview/` is a demo harness only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOW_STOCK } from '../config.js';
import { ROLE_LABELS } from '../menu.js';
import { addDays, combine, isoDate, shopNow, shopTimestamp, strftime } from '../time.js';
import { colorHex, compareSizes, groupProducts } from '../utils.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8'));

const NUMERIC = new Set([
  'audit_id', 'base_price', 'base_min', 'balance_after', 'category_id', 'current_price', 'current_stock',
  'discount_amount', 'discount_id', 'discount_percentage', 'display_order', 'dtr_id', 'grace_minutes',
  'gross_sales', 'hours_worked', 'item_count', 'item_id', 'log_id', 'low_stock', 'net_sales', 'order_count',
  'orders_today', 'overtime_hours', 'pending_deliveries', 'permit_id', 'price_max', 'price_min', 'product_count',
  'product_id', 'quantity', 'quantity_changed', 'quantity_refunded', 'refund_amount', 'refund_count', 'refund_id',
  'refunds_today', 'revenue', 'sale_id', 'sales_today', 'sort_order', 'staff_clocked_in', 'stock', 'subtotal',
  'total_amount', 'total_hours', 'total_refunded', 'total_sales', 'units', 'units_refunded', 'user_id',
  'unit_price_at_sale', 'variants', 'line_total', 'active_promos',
]);

/** JSON has no dates or numbers-with-types: restore what the database layer would have returned. */
function restore(value, key = '') {
  if (Array.isArray(value)) return value.map((entry) => restore(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, restore(entry, name)]));
  }
  if (typeof value !== 'string') return value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return new Date(value);
  if (NUMERIC.has(key) && /^-?\d+(\.\d+)?$/.test(value) && !/^0\d/.test(value)) return Number(value);
  return value;
}

export const fixtures = restore(raw);
export const ids = fixtures.ids;
export const imageFiles = fixtures.image_files || {};
export const generatedAt = fixtures.generated_at;
export const lowStock = fixtures.source?.low_stock ?? LOW_STOCK;

const staff = fixtures.staff || [];
const products = fixtures.products || [];
const sales = fixtures.sales || [];
const categories = fixtures.categories || [];

const money = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const byId = (list, key, value) => list.find((row) => row[key] === value) || null;

// ---------------------------------------------------------------- shared derived data

/** Stock levels change while the preview runs, so keep the mutable copy separate from the snapshot. */
const state = {
  products: products.map((product) => ({ ...product })),
  inventory: (fixtures.inventory || []).map((row) => ({ ...row })),
  movements: (fixtures.movements || []).map((row) => ({ ...row })),
  sales: sales.map((sale) => ({ ...sale })),
  staff: staff.map((person) => ({ ...person })),
  discounts: (fixtures.discounts || []).map((discount) => ({ ...discount })),
  myAttendance: (fixtures.my_attendance || []).map((row) => ({ ...row })),
  overtime: (fixtures.overtime || []).map((row) => ({ ...row })),
};

export function resetState() {
  state.products = products.map((product) => ({ ...product }));
  state.inventory = (fixtures.inventory || []).map((row) => ({ ...row }));
  state.movements = (fixtures.movements || []).map((row) => ({ ...row }));
  state.sales = sales.map((sale) => ({ ...sale }));
  state.staff = staff.map((person) => ({ ...person }));
  state.discounts = (fixtures.discounts || []).map((discount) => ({ ...discount }));
  state.myAttendance = (fixtures.my_attendance || []).map((row) => ({ ...row }));
  state.overtime = (fixtures.overtime || []).map((row) => ({ ...row }));
}

function range(query = {}) {
  const end = query.end ? new Date(`${String(query.end).slice(0, 10)}T00:00:00+08:00`) : addDays(shopNow(), 0);
  const start = query.start ? new Date(`${String(query.start).slice(0, 10)}T00:00:00+08:00`) : addDays(shopNow(), -30);
  return { start, end, startText: isoDate(start), endText: isoDate(end) };
}

// ---------------------------------------------------------------- shop / catalog

const activeProducts = () => state.products.filter((product) => product.is_active !== false);

function cardsFor(rows) {
  return groupProducts(rows).sort((left, right) => right.newest - left.newest);
}

function matchesText(row, needle) {
  if (!needle) return true;
  const haystack = [row.product_name, row.color, row.size, row.category_name, row.description]
    .filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

const SORTS = [
  { key: 'featured', label: 'Featured' },
  { key: 'newest', label: 'Newest' },
  { key: 'price_low', label: 'Price: low to high' },
  { key: 'price_high', label: 'Price: high to low' },
];

function sortCards(cards, sort) {
  const sorted = [...cards];
  if (sort === 'price_low') sorted.sort((a, b) => a.price_min - b.price_min);
  else if (sort === 'price_high') sorted.sort((a, b) => b.price_min - a.price_min);
  else if (sort === 'newest') sorted.sort((a, b) => b.newest - a.newest);
  return sorted;
}

export function catalog(query = {}) {
  const q = String(query.q || '').trim();
  const category = query.category ? Number(query.category) : null;
  const inStock = query.instock === '1';
  const sort = SORTS.some((entry) => entry.key === query.sort) ? query.sort : 'featured';
  const rows = activeProducts().filter((row) => matchesText(row, q)
    && (!category || row.category_id === category)
    && (!inStock || row.current_stock > 0));
  const cards = sortCards(cardsFor(rows), sort);
  const filtered = Boolean(q || category || inStock || sort !== 'featured');

  const sections = [];
  for (const card of cards) {
    let section = sections.find((entry) => entry.name === card.category);
    if (!section) {
      section = { name: card.category || 'More to explore', cards: [] };
      sections.push(section);
    }
    section.cards.push(card);
  }
  if (sort !== 'featured') sections.sort((a, b) => b.cards[0].newest - a.cards[0].newest);

  return {
    categories,
    category: category || '',
    q,
    in_stock: inStock,
    sort,
    sorts: SORTS,
    filtered,
    cards,
    sections,
  };
}

export function suggestions(query = {}) {
  const q = String(query.q || '').trim();
  const category = query.category ? Number(query.category) : null;
  const rows = activeProducts().filter((row) => row.current_stock > 0 && matchesText(row, q)
    && (!category || row.category_id === category));
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.category_name}||${row.product_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: `/product/${row.product_id}`,
      name: row.display_name || row.product_name,
      price: money(row.current_price),
    });
    if (out.length === 6) break;
  }
  return out;
}

export function productPage(productId, query = {}) {
  const wanted = Number(productId);
  const card = cardsFor(activeProducts()).find((entry) => entry.rows.some((row) => row.product_id === wanted))
    || cardsFor(activeProducts())[0];
  if (!card) return null;

  const rows = card.rows;
  const requestedColor = String(query.color || '').trim();
  const selected = card.colors.some((color) => color.name === requestedColor)
    ? requestedColor
    : (card.colors[0]?.name || '');
  const item = rows.find((row) => row.product_id === wanted) || rows[0];
  const variants = (fixtures.variants?.[String(card.first_id)] || rows).map((variant) => ({ ...variant }));
  const gallery = (fixtures.photos?.[String(card.first_id)] || []).map((photo) => photo.image_id);
  const photoIds = gallery.filter((id) => imageFiles[String(id)]);
  const chosen = Number(query.photo);
  const mainIndex = Math.max(0, photoIds.indexOf(chosen));
  const colorRow = rows.find((row) => row.color === selected) || item;

  return {
    item: { ...item, product_name: card.name, description: card.description },
    category: card.category,
    colors: card.colors,
    selected,
    variants,
    photo_ids: photoIds,
    photo_urls: photoIds.map((imageId) => `/media/product/${imageId}`),
    main_photo: photoIds[mainIndex] ?? null,
    main_index: mainIndex,
    price_min: card.price_min,
    price_max: card.price_max,
    base_price: colorRow.base_price,
    status: card.status,
    stock: card.stock,
    low_stock_limit: lowStock,
  };
}

// ---------------------------------------------------------------- dashboard

export function dashboard() {
  const summary = fixtures.dashboard?.summary || null;
  const days = fixtures.dashboard?.days || [];
  const peak = Math.max(0, ...days.map((day) => money(day.total_sales))) || 1;
  return {
    low: lowStock,
    s: summary,
    bars: days.map((day) => ({
      day: day.sale_day,
      total: money(day.total_sales),
      orders: Number(day.order_count) || 0,
      pct: Math.round((money(day.total_sales) / peak) * 100),
    })),
    top: fixtures.dashboard?.top || [],
    week_total: days.reduce((sum, day) => sum + money(day.total_sales), 0),
  };
}

// ---------------------------------------------------------------- point of sale

export function posPage(query = {}, cart = {}) {
  const q = String(query.q || '').trim();
  const category = query.category ? Number(query.category) : null;
  const rows = state.products
    .filter((row) => row.is_active !== false && matchesText(row, q) && (!category || row.category_id === category))
    .sort((left, right) => (right.current_stock > 0) - (left.current_stock > 0)
      || left.product_name.localeCompare(right.product_name)
      || compareSizes(left.size, right.size));

  const lines = cartLines(cart);
  return {
    q,
    category: category || '',
    categories: categories.map((entry) => [entry.category_id, entry.category_name]),
    products: rows,
    lines,
    total: lines.reduce((sum, line) => sum + line.line_total, 0),
    low_stock_limit: lowStock,
  };
}

export function cartLines(cart = {}) {
  const lines = [];
  for (const [key, quantity] of Object.entries(cart)) {
    const product = byId(state.products, 'product_id', Number(key));
    const qty = Number(quantity) || 0;
    if (!product || qty <= 0) continue;
    lines.push({
      product,
      qty,
      short: qty > product.current_stock,
      line_total: money(product.current_price) * qty,
    });
  }
  return lines;
}

export function cartProduct(productId) {
  return byId(state.products, 'product_id', Number(productId));
}

export function nextSaleId() {
  return Math.max(9000, ...state.sales.map((sale) => Number(sale.sale_id) || 0)) + 1;
}

/** Turns the demo cart into an order row, the way a finished checkout handler would. */
export function checkout(cart, fields, user) {
  const lines = cartLines(cart);
  const saleId = nextSaleId();
  const subtotal = lines.reduce((sum, line) => sum + line.line_total, 0);
  const sale = {
    sale_id: saleId,
    user_id: user.user_id,
    cashier: `${user.first_name} ${user.last_name}`.trim(),
    sale_date: shopNow(),
    fulfillment_type: fields.fulfillment_type || 'Walk-in',
    customer_name: fields.customer_name || null,
    customer_contact: fields.customer_contact || null,
    delivery_address: fields.delivery_address || null,
    subtotal,
    discount_amount: 0,
    total_amount: subtotal,
    payment_method: fields.payment_method || 'Cash',
    order_status: 'Completed',
    rider_service: null,
    rider_contact: null,
    item_count: lines.length,
  };
  state.sales.unshift(sale);
  const usedItemIds = Object.values(fixtures.sale_details || {}).flatMap((detail) => detail.items || []);
  let nextItemId = Math.max(0, ...usedItemIds.map((item) => Number(item.item_id) || 0)) + 1;
  const items = [];
  for (const line of lines) {
    const product = byId(state.products, 'product_id', line.product.product_id);
    if (!product) continue;
    items.push({
      item_id: nextItemId++,
      product_id: product.product_id,
      product_name: product.display_name || product.product_name,
      quantity: line.qty,
      base_price: money(product.base_price),
      unit_price_at_sale: money(product.current_price),
      line_total: line.line_total,
      discount_name: product.discount_name || null,
      quantity_refunded: 0,
    });
    product.current_stock = Math.max(0, product.current_stock - line.qty);
    const inventoryRow = byId(state.inventory, 'product_id', product.product_id);
    if (inventoryRow) {
      inventoryRow.current_stock = product.current_stock;
      inventoryRow.is_low = product.current_stock <= lowStock;
    }
    state.movements.unshift({
      log_id: Math.max(0, ...state.movements.map((row) => Number(row.log_id) || 0)) + 1,
      logged_at: shopNow(),
      product_id: product.product_id,
      product_name: product.product_name,
      transaction_type: 'SALE',
      quantity_changed: -line.qty,
      balance_after: product.current_stock,
      sale_id: saleId,
      staff_name: sale.cashier,
    });
  }
  fixtures.sale_details[String(saleId)] = { sale: { ...sale }, items };
  return sale;
}

// ---------------------------------------------------------------- orders

const ORDER_STATUSES = ['Pending', 'Out_for_Delivery', 'Completed', 'Cancelled', 'Partially_Refunded', 'Refunded'];

export function ordersPage(query = {}) {
  const { start, end } = range(query);
  const status = String(query.status || '');
  const from = start.getTime();
  const to = addDays(end, 1).getTime();
  const rows = state.sales
    .filter((sale) => {
      const when = sale.sale_date instanceof Date ? sale.sale_date.getTime() : 0;
      return when >= from && when < to && (!status || sale.order_status === status);
    })
    .sort((left, right) => right.sale_date - left.sale_date);
  const total = rows
    .filter((sale) => !['Cancelled', 'Refunded'].includes(sale.order_status))
    .reduce((sum, sale) => sum + money(sale.total_amount), 0);
  return { start, end, statuses: ORDER_STATUSES, status, rows, total };
}

export function saleFor(saleId) {
  const wanted = Number(saleId);
  const sale = byId(state.sales, 'sale_id', wanted);
  if (!sale) return null;
  const detail = fixtures.sale_details?.[String(wanted)];
  const items = detail?.items?.length ? detail.items : (detail ? [] : []);
  // Live state wins: a status/refund change made in the preview must not be undone by the snapshot.
  return { sale: { ...(detail?.sale || {}), ...sale }, items: items.map((item) => ({ ...item })) };
}

export function setOrderStatus(saleId, status, fields = {}) {
  const sale = byId(state.sales, 'sale_id', Number(saleId));
  if (!sale) return null;
  sale.order_status = status;
  if (fields.rider_service) sale.rider_service = fields.rider_service;
  if (fields.rider_contact) sale.rider_contact = fields.rider_contact;
  return sale;
}

// ---------------------------------------------------------------- inventory

export function inventoryPage(query = {}) {
  const q = String(query.q || '').trim();
  const category = String(query.category || '').trim();
  const lowOnly = query.low === '1';
  const limit = Number(query.max) > 0 ? Number(query.max) : lowStock;
  const items = state.inventory.filter((row) => (!q || matchesText({ product_name: row.product_name, category_name: row.category_name }, q))
    && (!category || row.category_name === category)
    && (!lowOnly || row.current_stock <= limit));
  return {
    items: items.map((row) => ({ ...row, is_low: row.current_stock <= limit })),
    q,
    category,
    categories: [...new Set(state.inventory.map((row) => row.category_name))].filter(Boolean).sort(),
    limit,
    low_only: lowOnly,
    low_stock_limit: lowStock,
  };
}

export function inventoryItemPage(productId) {
  const product = byId(state.products, 'product_id', Number(productId)) || state.products[0];
  if (!product) return null;
  const rows = state.movements
    .filter((row) => row.product_id === product.product_id)
    .sort((left, right) => right.logged_at - left.logged_at)
    .slice(0, 50);
  return { product, rows };
}

export function moveStock(productId, action, quantity, user) {
  const product = byId(state.products, 'product_id', Number(productId));
  if (!product) return null;
  const amount = Math.trunc(Number(quantity) || 0);
  const delta = action === 'in' ? Math.abs(amount) : action === 'out' ? -Math.abs(amount) : 0;
  const before = product.current_stock;
  product.current_stock = action === 'adjust' ? Math.max(0, amount) : Math.max(0, before + delta);
  const inventoryRow = byId(state.inventory, 'product_id', product.product_id);
  if (inventoryRow) {
    inventoryRow.current_stock = product.current_stock;
    inventoryRow.is_low = product.current_stock <= lowStock;
  }
  state.movements.unshift({
    log_id: Math.max(0, ...state.movements.map((row) => Number(row.log_id) || 0)) + 1,
    logged_at: shopNow(),
    product_id: product.product_id,
    product_name: product.product_name,
    transaction_type: action === 'in' ? 'STOCK IN' : action === 'out' ? 'STOCK OUT' : 'ADJUSTMENT',
    quantity_changed: product.current_stock - before,
    balance_after: product.current_stock,
    sale_id: null,
    staff_name: `${user.first_name} ${user.last_name}`.trim(),
  });
  return product;
}

// ---------------------------------------------------------------- attendance

function shiftInput(value) {
  return value ? shopTimestamp(value).slice(0, 16) : '';
}

const hhmm = (value) => String(value || '').slice(0, 5);
const inputDate = (value) => (value ? isoDate(value) : '');

export function attendanceMine() {
  const setting = fixtures.shift_setting || { shift_start: '09:00:00', shift_end: '17:00:00', grace_minutes: 15, shift_hours: 8 };
  const shiftHours = money(setting.shift_hours) || 8;
  const today = isoDate(shopNow());
  const rows = [...state.myAttendance].sort((left, right) => right.time_in - left.time_in);
  const openRow = rows.find((row) => !row.time_out) || null;
  const todayDone = rows.some((row) => row.time_out && isoDate(row.time_in) === today);

  let st = null;
  if (openRow) {
    const worked = Math.max(0, (shopNow() - openRow.time_in) / 3600000);
    st = {
      worked,
      pct: Math.min(100, Math.round((worked / shiftHours) * 100)),
      opens_at: new Date(openRow.time_in.getTime() + shiftHours * 3600000),
    };
  }

  const permitRow = (fixtures.my_overtime || []).find((permit) => inputDate(permit.work_date) === today) || null;
  let ot = null;
  if (permitRow) {
    const start = combine(permitRow.work_date, permitRow.start_time);
    const finish = combine(permitRow.work_date, permitRow.end_time);
    const graceUntil = new Date(start.getTime() + (Number(permitRow.grace_minutes) || 0) * 60000);
    const now = shopNow();
    let stage = 'ready';
    if (permitRow.time_in && !permitRow.time_out) stage = 'open';
    else if (permitRow.time_out) stage = 'done';
    else if (now > finish) stage = 'over';
    else if (now < start) stage = 'early';
    else if (openRow) stage = 'wait';
    ot = { start, end: finish, grace_until: graceUntil, state: stage, late: now > graceUntil };
  }

  return {
    tab: 'mine',
    rows,
    open_row: openRow,
    st,
    shift: shiftHours,
    today_done: todayDone,
    can_clock_in: !openRow && !todayDone,
    ot,
    permit: permitRow,
    upcoming: (fixtures.my_overtime || [])
      .filter((permit) => inputDate(permit.work_date) > today)
      .map((permit) => ({ work_date: permit.work_date, start_time: permit.start_time, end_time: permit.end_time })),
  };
}

export function clockIn(user) {
  const now = shopNow();
  const setting = fixtures.shift_setting || {};
  const start = combine(now, setting.shift_start || '09:00:00');
  state.myAttendance.unshift({
    dtr_id: Math.max(9000, ...state.myAttendance.map((row) => Number(row.dtr_id) || 0)) + 1,
    user_id: user.user_id,
    shift_type: 'Regular',
    time_in: now,
    time_out: null,
    total_hours: null,
    overtime_hours: 0,
    status: now > start ? 'Late' : 'Present',
    note: null,
  });
}

export function clockOut() {
  const openRow = state.myAttendance.find((row) => !row.time_out);
  if (!openRow) return false;
  openRow.time_out = shopNow();
  openRow.total_hours = Math.round(((openRow.time_out - openRow.time_in) / 3600000) * 100) / 100;
  return true;
}

export function attendanceEveryone(query = {}) {
  const { start, end } = range(query);
  const userId = query.user_id ? Number(query.user_id) : null;
  const from = start.getTime();
  const to = addDays(end, 1).getTime();
  const rows = (fixtures.attendance_board || [])
    .filter((row) => {
      const when = row.work_day instanceof Date ? row.work_day.getTime() : 0;
      return when >= from && when < to && (!userId || row.user_id === userId);
    })
    .sort((left, right) => right.work_day - left.work_day);
  const counts = { Present: 0, Late: 0, Absent: 0 };
  for (const row of rows) {
    if (row.status === 'Present') counts.Present += 1;
    else if (row.status === 'Late') counts.Late += 1;
    else if (row.status === 'Absent' || row.status === 'Not in yet') counts.Absent += 1;
  }
  const hours = rows.reduce((sum, row) => sum + money(row.total_hours), 0);
  const overtime = rows.reduce((sum, row) => sum + money(row.overtime_hours), 0);
  const today = shopNow();
  return {
    tab: 'everyone',
    start,
    end,
    staff: state.staff,
    user_id: userId || '',
    presets: [
      ['Today', today, today],
      ['Last 7 days', addDays(today, -7), today],
      ['Last 30 days', addDays(today, -30), today],
    ],
    counts,
    hours,
    overtime,
    rows,
  };
}

export function overtimePage(query = {}) {
  const { start, end } = range(query);
  const from = start.getTime();
  const to = addDays(end, 1).getTime();
  return {
    tab: 'overtime',
    start,
    end,
    rows: state.overtime
      .filter((row) => row.work_date instanceof Date && row.work_date.getTime() >= from && row.work_date.getTime() < to)
      .sort((left, right) => right.work_date - left.work_date),
  };
}

export function shiftFormPage(dtrId) {
  const record = dtrId ? fixtures.shifts?.[String(dtrId)] : null;
  return {
    staff: state.staff,
    shift: record ? {
      ...record,
      time_in: shiftInput(record.time_in),
      time_out: shiftInput(record.time_out),
    } : { dtr_id: null, user_id: '', time_in: '', time_out: '', note: '' },
  };
}

export function overtimeFormPage(permitId) {
  const record = permitId ? fixtures.permits?.[String(permitId)] : null;
  return {
    editing: Boolean(record),
    staff: state.staff,
    default_grace: Number(fixtures.shift_setting?.grace_minutes) || 15,
    permit: record ? {
      ...record,
      work_date: inputDate(record.work_date),
      start_time: hhmm(record.start_time),
      end_time: hhmm(record.end_time),
    } : { permit_id: null, user_id: '', work_date: isoDate(shopNow()), start_time: '18:00', end_time: '21:00', grace_minutes: null, note: '' },
  };
}

export function schedulePage() {
  const setting = fixtures.shift_setting || {};
  return {
    tab: 'schedule',
    s: {
      shift_start: hhmm(setting.shift_start || '09:00'),
      shift_end: hhmm(setting.shift_end || '17:00'),
      grace_minutes: Number(setting.grace_minutes) || 15,
    },
  };
}

// ---------------------------------------------------------------- promos

export function promosPage() {
  return { rows: state.discounts.filter((discount) => discount.status === 'Active') };
}

export function adminPromosPage() {
  return { rows: state.discounts };
}

function promoProducts() {
  const seen = new Map();
  for (const product of state.products) {
    const key = `${product.category_name}||${product.product_name}`;
    if (!seen.has(key)) seen.set(key, { product_id: product.product_id, name: product.product_name });
  }
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function promoFormPage(discountId) {
  const record = discountId ? fixtures.promos?.[String(discountId)] : null;
  if (record) {
    const variantsByName = new Map((record.linkedNames || []).map((entry) => [entry.product_name, Number(entry.variants) || 0]));
    return {
      editing: true,
      discount_id: Number(discountId),
      today: shopNow(),
      products: promoProducts(),
      promo: { ...record.promo },
      linked: (record.linked || []).map((product) => ({
        product_id: product.product_id,
        name: product.product_name,
        base: money(product.base_price),
        promo: money(product.current_price),
        variants: variantsByName.get(product.product_name) ?? 1,
      })),
    };
  }
  return {
    editing: false,
    discount_id: null,
    today: shopNow(),
    products: promoProducts(),
    promo: { scope: 'NONE', product_id: null },
    linked: [],
  };
}

export function promoViewPage(discountId) {
  const record = fixtures.promos?.[String(discountId)] || fixtures.promos?.[String(ids.discount_id)];
  if (!record) return null;
  const variantsByName = new Map((record.linkedNames || []).map((entry) => [entry.product_name, Number(entry.variants) || 0]));
  return {
    promo: record.promo,
    linked: (record.linked || []).map((product) => ({
      product_id: product.product_id,
      name: product.product_name,
      base: money(product.base_price),
      promo: money(product.current_price),
      variants: variantsByName.get(product.product_name) ?? 1,
    })),
  };
}

export function endPromo(discountId) {
  const discount = byId(state.discounts, 'discount_id', Number(discountId));
  if (discount) discount.status = 'Ended';
  return discount;
}

// ---------------------------------------------------------------- refunds

export function refundsPage(query = {}) {
  const { start, end } = range(query);
  const from = start.getTime();
  const to = addDays(end, 1).getTime();
  const refunds = (fixtures.refunds || [])
    .filter((refund) => refund.refund_date instanceof Date
      && refund.refund_date.getTime() >= from && refund.refund_date.getTime() < to);
  return {
    start,
    end,
    report: fixtures.refund_report || [],
    refunds,
  };
}

export function refundSalePage(saleId) {
  const wanted = Number(saleId);
  const found = saleFor(wanted);
  if (!found) return null;
  return {
    sale: found.sale,
    items: found.items,
    can_refund: ['Completed', 'Partially_Refunded'].includes(found.sale.order_status),
  };
}

// ---------------------------------------------------------------- audit log

const ENTITY_LABELS = {
  product: 'Product',
  category: 'Category',
  sales: 'Order',
  sale_item: 'Order item',
  refund: 'Refund',
  discount: 'Promo',
  users: 'Staff account',
  daily_time_record: 'Shift',
  overtime_permit: 'Overtime',
  inventory_logs: 'Stock',
  shift_setting: 'Schedule',
  management_pin: 'Approval PIN',
  product_photo: 'Product photo',
  product_image: 'Product image',
};

const ACTION_WORDS = { INSERT: 'Created', UPDATE: 'Updated', DELETE: 'Deleted', SET_PIN: 'Set PIN' };

function showValue(value) {
  if (value === null || value === undefined || value === '') return '\u2014';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function changesFor(before, after) {
  if (!before || !after) return [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes = [];
  for (const key of keys) {
    const left = before[key];
    const right = after[key];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    changes.push({ field: key.replaceAll('_', ' '), before: showValue(left), after: showValue(right) });
  }
  return changes;
}

function auditSubject(entry) {
  const after = entry.after_data || entry.before_data || {};
  if (after.product_name) return after.product_name;
  if (after.discount_name) return after.discount_name;
  if (after.category_name) return after.category_name;
  if (after.username) return after.username;
  if (entry.entity === 'sales' && after.sale_id) return `Order #${after.sale_id}`;
  if (entry.entity === 'daily_time_record' && after.dtr_id) return `Shift #${after.dtr_id}`;
  if (after.sale_id) return `Order #${after.sale_id}`;
  if (after.product_id) return `Product #${after.product_id}`;
  if (after.user_id) return `User #${after.user_id}`;
  return '';
}

export function auditPage(query = {}) {
  const { start, end } = range(query);
  const actor = String(query.actor || '').trim();
  const entity = String(query.entity || '');
  const action = String(query.action || '');
  const page = Math.max(1, Number(query.page) || 1);
  const perPage = 50;

  const people = new Map(state.staff.map((person) => [person.username, person]));
  const filtered = (fixtures.audit || []).filter((entry) => {
    const when = entry.occurred_at instanceof Date ? entry.occurred_at.getTime() : 0;
    return when >= start.getTime() && when < addDays(end, 1).getTime()
      && (!actor || String(entry.actor || '').toLowerCase().includes(actor.toLowerCase()))
      && (!entity || entry.entity === entity)
      && (!action || entry.action === action);
  });

  const entities = [...new Set((fixtures.audit || []).map((entry) => entry.entity))]
    .map((key) => [key, ENTITY_LABELS[key] || key.replaceAll('_', ' ')]);

  const rows = filtered.slice((page - 1) * perPage, page * perPage).map((entry) => {
    const person = people.get(entry.actor);
    return {
      audit_id: entry.audit_id,
      time: entry.occurred_at,
      name: person ? `${person.first_name} ${person.last_name}`.trim() : (entry.actor || 'System'),
      actor: entry.actor || 'system',
      role: person ? (ROLE_LABELS[person.user_type] || person.user_type) : 'System',
      approved_by: entry.approved_by,
      subject: auditSubject(entry),
      details: `${ACTION_WORDS[entry.action] || entry.action} ${(ENTITY_LABELS[entry.entity] || entry.entity).toLowerCase()}`,
      changes: changesFor(entry.before_data, entry.after_data),
      security_only: ['users', 'management_pin'].includes(entry.entity),
    };
  });

  return {
    filters: { start: isoDate(start), end: isoDate(end), actor, entity, action },
    entities,
    rows,
    page,
    more: filtered.length > page * perPage,
  };
}

// ---------------------------------------------------------------- admin: products

export function adminProductsPage(query = {}) {
  const q = String(query.q || '').trim();
  const category = query.category ? Number(query.category) : null;
  const showInactive = query.inactive === '1';
  const variantsView = query.variants === '1';
  const rows = state.products.filter((row) => matchesText(row, q)
    && (!category || row.category_id === category)
    && (showInactive || row.is_active !== false));
  return {
    products: rows,
    cards: variantsView ? [] : cardsFor(rows),
    categories,
    q,
    category: category || '',
    show_inactive: showInactive,
    variants_view: variantsView,
    low_stock_limit: lowStock,
  };
}

export function productFormPage(productId) {
  const editing = Boolean(productId);
  const product = editing ? byId(state.products, 'product_id', Number(productId)) : null;
  const chosen = product || state.products[0];
  if (!chosen) return null;
  const variants = editing ? (fixtures.variants?.[String(chosen.product_id)] || []) : [];
  return {
    editing,
    product_id: editing ? Number(productId) : null,
    categories,
    product: editing ? product : {},
    current: product,
    variants,
  };
}

export function photosPage(productId) {
  const chosen = byId(state.products, 'product_id', Number(productId)) || state.products[0];
  if (!chosen) return null;
  const card = cardsFor(activeProducts()).find((entry) => entry.rows.some((row) => row.product_id === chosen.product_id));
  const gallery = (fixtures.photos?.[String(card?.first_id || chosen.product_id)] || [])
    .map((photo) => photo.image_id)
    .filter((imageId) => imageFiles[String(imageId)]);
  const colorRows = card?.rows || [chosen];
  const colors = [];
  for (const row of colorRows) {
    const name = row.color || '';
    if (!colors.some((entry) => entry.name === name)) colors.push({ name, first_id: row.product_id });
  }
  return {
    product_id: chosen.product_id,
    current: { ...chosen, product_name: card?.name || chosen.product_name },
    colors,
    gallery: gallery.map((imageId) => ({ image_id: imageId })),
    photo_urls: gallery.map((imageId) => `/media/product/${imageId}`),
    many_sizes: new Set(colorRows.map((row) => row.size)).size > 1,
  };
}

export function categoriesPage() {
  return { categories: categories.map((category) => ({ ...category, product_count: Number(category.product_count) || 0 })) };
}

// ---------------------------------------------------------------- admin: staff

export function staffPage() {
  return { staff: state.staff };
}

export function staffFormPage(userId) {
  const person = userId ? byId(state.staff, 'user_id', Number(userId)) : null;
  return {
    editing: Boolean(person),
    user_id: person ? person.user_id : null,
    person: person || {},
  };
}

// ---------------------------------------------------------------- images

export function imageFor(imageId) {
  const file = imageFiles[String(imageId)];
  return file ? path.join(here, 'images', file) : null;
}

/** A drawn stand-in for a product that has no photo, so cards never look broken. */
export function placeholderSvg(imageId) {
  const product = state.products.find((row) => row.image_id === Number(imageId));
  const label = (product?.product_name || 'The Fad').slice(0, 18);
  const hex = colorHex(product?.color) || '#d9d5cd';
  const text = label.replace(/[<>&]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 600" role="img" aria-label="${text}">
  <rect width="480" height="600" fill="${hex}"/>
  <rect x="40" y="40" width="400" height="520" fill="none" stroke="#ffffff55" stroke-width="2"/>
  <text x="240" y="300" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="#22262b">${text}</text>
  <text x="240" y="344" text-anchor="middle" font-family="Helvetica, sans-serif" font-size="16" fill="#22262b99">The Fad</text>
</svg>`;
}

// The preview mutates these in memory so a demo click has a visible effect; the real app never imports this file.
export { state, categories };

