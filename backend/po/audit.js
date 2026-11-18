/**
 * Audit log — extra screen kept with Po (matches the project ownership notes).
 * This is not one of the nine entities in the assignment table.
 */
import * as db from '../../db.js';
import { flash } from '../../flash.js';
import { renderPage } from '../../render.js';
import { ROLE_LABELS } from '../../menu.js';
import { addDays, isoDate, shopNow } from '../../time.js';
import { ValidationError } from '../../utils.js';
import { roleRequired } from '../shared/auth.js';

const PER_PAGE = 50;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** The tables the audit trigger watches, with the labels the filter and rows use. */
const ENTITIES = [
  ['product', 'Product'],
  ['category', 'Category'],
  ['sales', 'Order'],
  ['sale_item', 'Order item'],
  ['refund', 'Refund'],
  ['discount', 'Promo'],
  ['users', 'Staff account'],
  ['daily_time_record', 'Shift'],
  ['overtime_permit', 'Overtime'],
  ['inventory_logs', 'Stock'],
  ['shift_setting', 'Schedule'],
  ['management_pin', 'Approval PIN'],
];
const ENTITY_LABELS = Object.fromEntries(ENTITIES);
const ACTION_WORDS = { INSERT: 'Created', UPDATE: 'Updated', DELETE: 'Deleted', SET_PIN: 'Set PIN' };
const ACTIONS = Object.keys(ACTION_WORDS);

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
  return { startText, endText };
}

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

function subjectFor(entry) {
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

export default function register(router) {
  // DB: fn_audit_logs(start, end, actor, entity, action, offset), fn_list_staff()
  router.get('/admin/audit', 'audit.index', roleRequired('AD'), async (req, res) => {
    const { startText, endText } = readRange(req);
    const actor = String(req.query.actor || '').trim();
    const entity = ENTITIES.some(([key]) => key === req.query.entity) ? req.query.entity : '';
    const action = ACTIONS.includes(req.query.action) ? req.query.action : '';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    let rows = [];
    let staff = [];
    try {
      rows = await db.callFunction(
        'fn_audit_logs', startText, endText, actor || null, entity || null, action || null, (page - 1) * PER_PAGE,
      );
      staff = await db.callFunction('fn_list_staff');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    const people = new Map(staff.map((person) => [person.username, person]));
    const entries = rows.slice(0, PER_PAGE).map((row) => {
      const person = people.get(row.actor);
      const fullName = person ? `${person.first_name || ''} ${person.last_name || ''}`.trim() : '';
      const role = row.actor_role || (person ? person.user_type : '');
      return {
        audit_id: row.audit_id,
        time: row.occurred_at,
        // Newer databases store the name with the event; older ones need the staff lookup.
        name: String(row.actor_name || '').trim() || fullName || row.actor || 'System',
        actor: row.actor || 'system',
        role: role ? (ROLE_LABELS[role] || role) : 'System',
        approved_by: row.approved_by,
        subject: subjectFor(row),
        details: `${ACTION_WORDS[row.action] || row.action} ${(ENTITY_LABELS[row.entity] || row.entity).toLowerCase()}`,
        changes: changesFor(row.before_data, row.after_data),
        security_only: ['users', 'management_pin'].includes(row.entity),
      };
    });
    return renderPage(req, res, 'audit.html', {
      filters: { start: startText, end: endText, actor, entity, action },
      entities: ENTITIES,
      rows: entries,
      page,
      more: rows.length > PER_PAGE,
    });
  });
}
