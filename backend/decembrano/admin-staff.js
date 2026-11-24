/** USERS — staff accounts. Owner: Decembrano. */
import * as db from '../../db.js';
import { flash } from '../../flash.js';
import { renderPage } from '../../render.js';
import { isoDate, parseTimestamp } from '../../time.js';
import { urlFor } from '../../urls.js';
import { ValidationError } from '../../utils.js';
import { roleRequired } from '../shared/auth.js';

function readText(value, label, max, { required = true } = {}) {
  const text = String(value ?? '').trim();
  if (!text && required) throw new ValidationError(`${label} is required.`);
  if (text.length > max) throw new ValidationError(`${label} cannot be longer than ${max} characters.`);
  return text;
}

function readHireDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = parseTimestamp(text);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !parsed || isoDate(parsed) !== text) {
    throw new ValidationError('Enter a valid start date.');
  }
  return text;
}

function readStaff(body, editing) {
  const username = readText(body.username, 'Username', 50);
  if (!editing && username.length < 3) throw new ValidationError('Username must be at least 3 characters.');
  const firstName = readText(body.first_name, 'First name', 50);
  const lastName = readText(body.last_name, 'Last name', 50);
  const email = readText(body.email, 'Email', 255);
  if (!email.includes('@')) throw new ValidationError('Enter a valid email address.');
  const userType = String(body.user_type || '').trim();
  if (!['CA', 'AD'].includes(userType)) throw new ValidationError('Choose Cashier or Manager.');
  const station = readText(body.station, 'Station', 50, { required: false }) || null;
  const hiredOn = readHireDate(body.hired_on);
  const password = editing ? null : String(body.password || '');
  if (!editing && password.length < 8) throw new ValidationError('Temporary password must be at least 8 characters.');
  return { username, first_name: firstName, last_name: lastName, email, user_type: userType, station, hired_on: hiredOn, password };
}

function staffForm(req, res, person, editing, userId, status = 200) {
  return renderPage(req, res, 'admin/staff_form.html', {
    editing,
    user_id: userId,
    person,
  }, status);
}

export default function register(router) {
  router.get('/admin/staff', 'admin_staff.index', roleRequired('AD'), async (req, res) => {
    let staff = [];
    try {
      staff = await db.callFunction('fn_list_staff');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return renderPage(req, res, 'admin/staff.html', { staff });
  });

  router.get('/admin/staff/new', 'admin_staff.new', roleRequired('AD'), (req, res) => (
    staffForm(req, res, {}, false, null)
  ));

  router.post('/admin/staff/new', 'admin_staff.new', roleRequired('AD'), async (req, res) => {
    let values;
    try {
      values = readStaff(req.body, false);
    } catch (error) {
      flash(req, 'error', error.message);
      return staffForm(req, res, req.body, false, null, 400);
    }
    try {
      await db.callProcedure(
        'sp_create_staff',
        values.username,
        values.password,
        values.first_name,
        values.last_name,
        values.user_type,
        values.email,
        values.station,
        values.hired_on,
        null,
      );
      flash(req, 'success', 'Staff account added.');
      return res.redirect(urlFor('admin_staff.index'));
    } catch (error) {
      flash(req, 'error', error.message);
      return staffForm(req, res, req.body, false, null, 400);
    }
  });

  router.get('/admin/staff/:user_id(\\d+)/edit', 'admin_staff.edit', roleRequired('AD'), async (req, res) => {
    const userId = Number(req.params.user_id);
    let person = null;
    try {
      person = await db.callFunctionOne('fn_get_staff', userId);
    } catch (error) {
      flash(req, 'error', error.message);
      return res.redirect(urlFor('admin_staff.index'));
    }
    if (!person) {
      flash(req, 'error', 'That staff member does not exist.');
      return res.redirect(urlFor('admin_staff.index'));
    }
    return staffForm(req, res, person, true, userId);
  });

  router.post('/admin/staff/:user_id(\\d+)/edit', 'admin_staff.edit', roleRequired('AD'), async (req, res) => {
    const userId = Number(req.params.user_id);
    let values;
    try {
      values = readStaff(req.body, true);
    } catch (error) {
      flash(req, 'error', error.message);
      return staffForm(req, res, req.body, true, userId, 400);
    }
    try {
      await db.callProcedure(
        'sp_update_staff',
        userId,
        values.first_name,
        values.last_name,
        values.user_type,
        values.email,
        values.station,
        values.hired_on,
      );
      flash(req, 'success', 'Staff account updated.');
      return res.redirect(urlFor('admin_staff.index'));
    } catch (error) {
      flash(req, 'error', error.message);
      return staffForm(req, res, req.body, true, userId, 400);
    }
  });

  router.post('/admin/staff/:user_id(\\d+)/active', 'admin_staff.set_active', roleRequired('AD'), async (req, res) => {
    const userId = Number(req.params.user_id);
    const raw = String(req.body.active ?? '');
    if (raw !== '0' && raw !== '1') {
      flash(req, 'error', 'Choose whether the account should be active.');
      return res.redirect(urlFor('admin_staff.index'));
    }
    const active = raw === '1';
    if (!active && userId === req.session.user_id) {
      flash(req, 'error', 'You cannot deactivate your own account.');
      return res.redirect(urlFor('admin_staff.index'));
    }
    try {
      await db.callProcedure('sp_set_staff_active', userId, active);
      flash(req, 'success', active ? 'Account reactivated.' : 'Account deactivated.');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(urlFor('admin_staff.index'));
  });
}
