/**
 * DAILY_TIME_RECORD — clock in/out, overtime and attendance reports. Owner: Decembrano.
 *
 * The shared access check in ../shared/access.js is deliberately permissive until this
 * feature exists. When you build the shift gate, implement it there (or in a service file
 * in this folder) and keep the SIGN_IN_EXEMPT endpoints working.
 */

import { config } from '../../config.js';
import * as db from '../../db.js';
import { flash } from '../../flash.js';
import { renderPage } from '../../render.js';
import { shiftRules } from '../../rules.js';
import { addDays, isoDate, shopNow, shopTimestamp } from '../../time.js';
import { urlFor } from '../../urls.js';
import { toInt, ValidationError } from '../../utils.js';
import { loginRequired, roleRequired } from '../shared/auth.js';
import {
  attendanceBoardView,
  attendanceView,
  overtimeDefaults,
  overtimeFormValue,
  readDate,
  readOvertimeInput,
  readRange,
  readScheduleInput,
  readShiftInput,
  scheduleView,
  shiftDefaults,
  shiftFormValue,
} from './attendance-service.js';

const activeStaff = (staff) => staff.filter((person) => person.is_active);
const currentMax = (now = shopNow()) => shopTimestamp(now).slice(0, 16);

async function staffChoices(req) {
  try {
    return await db.callFunction('fn_list_staff');
  } catch (error) {
    flash(req, 'error', error.message);
    return [];
  }
}

function rangeOrFlash(req, query) {
  try {
    return readRange(query);
  } catch (error) {
    flash(req, 'error', error.message);
    return readRange({});
  }
}

function staffIdOrFlash(req, value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    const id = toInt(text, 'Staff member');
    if (id <= 0) throw new ValidationError('Choose a valid staff member.');
    return id;
  } catch (error) {
    flash(req, 'error', error.message);
    return null;
  }
}

function shiftForm(req, res, shift, staff, status = 200, now = shopNow()) {
  return renderPage(req, res, 'shift_form.html', {
    shift,
    staff: activeStaff(staff),
    max_time: currentMax(now),
  }, status);
}

function overtimeForm(req, res, permit, staff, editing, status = 200) {
  return renderPage(req, res, 'overtime_form.html', {
    editing,
    staff: activeStaff(staff),
    default_grace: Number(req._shiftRules?.grace) || 15,
    permit,
  }, status);
}

export default function register(router) {
  router.get('/attendance', 'attendance.index', loginRequired, async (req, res) => {
    const now = shopNow();
    const rules = await shiftRules(req);
    let rows = [];
    let permits = [];
    try {
      rows = await db.callFunction('fn_my_attendance', req.session.user_id, 30);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    try {
      permits = await db.callFunction('fn_my_overtime', req.session.user_id);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return renderPage(req, res, 'attendance.html', attendanceView(rows, permits, rules, req.staffAccess, now));
  });

  router.post('/attendance/clock-in', 'attendance.clock_in', loginRequired, async (req, res) => {
    const rules = await shiftRules(req);
    try {
      await db.callProcedure('sp_clock_in', req.session.user_id, rules.shift_start, rules.grace, rules.max_hours, null);
      flash(req, 'success', 'Clocked in.');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(urlFor('attendance.index'));
  });

  router.post('/attendance/clock-out', 'attendance.clock_out', loginRequired, async (req, res) => {
    const rules = await shiftRules(req);
    try {
      await db.callProcedure('sp_clock_out', req.session.user_id, rules.shift_hours, rules.max_hours, null, null);
      flash(req, 'success', 'Shift closed.');
    } catch (error) {
      flash(req, error.message.includes('automatically') ? 'info' : 'error', error.message);
    }
    return res.redirect(urlFor('attendance.index'));
  });

  router.post('/attendance/overtime-in', 'attendance.overtime_in', loginRequired, async (req, res) => {
    try {
      await db.callProcedure('sp_overtime_in', req.session.user_id, null);
      flash(req, 'success', 'Overtime started.');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(urlFor('attendance.index'));
  });

  router.post('/attendance/overtime-out', 'attendance.overtime_out', loginRequired, async (req, res) => {
    try {
      await db.callProcedure('sp_overtime_out', req.session.user_id, null);
      flash(req, 'success', 'Overtime closed.');
    } catch (error) {
      flash(req, error.message.includes('automatically') ? 'info' : 'error', error.message);
    }
    return res.redirect(urlFor('attendance.index'));
  });

  router.get('/attendance/everyone', 'attendance.everyone', roleRequired('AD'), async (req, res) => {
    const now = shopNow();
    const range = rangeOrFlash(req, req.query);
    const userId = staffIdOrFlash(req, req.query.user_id);
    let rows = [];
    let staff = [];
    try {
      [rows, staff] = await Promise.all([
        db.callFunction('fn_attendance_board', isoDate(range.start), isoDate(range.end), userId, config.workDays),
        db.callFunction('fn_list_staff'),
      ]);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    const view = attendanceBoardView(rows, userId);
    return renderPage(req, res, 'attendance_everyone.html', {
      tab: 'everyone',
      start: range.start,
      end: range.end,
      staff: activeStaff(staff),
      user_id: userId || '',
      presets: [
        ['Today', now, now],
        ['Last 7 days', addDays(now, -6), now],
        ['Last 30 days', addDays(now, -29), now],
      ],
      ...view,
    });
  });

  router.get('/attendance/shift', 'attendance.new_shift', roleRequired('AD'), async (req, res) => {
    const now = shopNow();
    const rules = await shiftRules(req);
    let staff = [];
    try {
      staff = await db.callFunction('fn_list_staff');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    const shift = shiftDefaults(rules, now);
    if (req.query.user_id) shift.user_id = staffIdOrFlash(req, req.query.user_id) || '';
    if (req.query.date) {
      try {
        const day = isoDate(readDate(req.query.date, 'Shift date'));
        shift.time_in = `${day}T${String(rules.shift_start).slice(0, 5)}`;
        shift.time_out = `${day}T${String(rules.shift_end).slice(0, 5)}`;
      } catch (error) {
        flash(req, 'error', error.message);
      }
    }
    return shiftForm(req, res, shift, staff, 200, now);
  });

  router.post('/attendance/shift', 'attendance.new_shift', roleRequired('AD'), async (req, res) => {
    const now = shopNow();
    const rules = await shiftRules(req);
    let values;
    try {
      values = readShiftInput(req.body, now);
    } catch (error) {
      flash(req, 'error', error.message);
      return shiftForm(req, res, { dtr_id: null, ...req.body }, await staffChoices(req), 400, now);
    }
    try {
      await db.callProcedure(
        'sp_save_shift',
        null,
        values.user_id,
        values.time_in,
        values.time_out,
        values.note,
        rules.shift_start,
        rules.grace,
        rules.shift_hours,
        rules.max_hours,
        null,
      );
      flash(req, 'success', 'Shift saved.');
      return res.redirect(urlFor('attendance.everyone'));
    } catch (error) {
      flash(req, 'error', error.message);
      return shiftForm(req, res, { dtr_id: null, ...req.body }, await staffChoices(req), 400, now);
    }
  });

  router.get('/attendance/shift/:dtr_id(\\d+)', 'attendance.edit_shift', roleRequired('AD'), async (req, res) => {
    const dtrId = Number(req.params.dtr_id);
    let shift = null;
    let staff = [];
    try {
      [shift, staff] = await Promise.all([
        db.callFunctionOne('fn_get_shift', dtrId),
        db.callFunction('fn_list_staff'),
      ]);
    } catch (error) {
      flash(req, 'error', error.message);
      return res.redirect(urlFor('attendance.everyone'));
    }
    if (!shift) {
      flash(req, 'error', 'That shift does not exist.');
      return res.redirect(urlFor('attendance.everyone'));
    }
    return shiftForm(req, res, shiftFormValue(shift), staff);
  });

  router.post('/attendance/shift/:dtr_id(\\d+)', 'attendance.edit_shift', roleRequired('AD'), async (req, res) => {
    const dtrId = Number(req.params.dtr_id);
    const now = shopNow();
    const rules = await shiftRules(req);
    let values;
    try {
      values = readShiftInput(req.body, now);
    } catch (error) {
      flash(req, 'error', error.message);
      return shiftForm(req, res, { dtr_id: dtrId, ...req.body }, await staffChoices(req), 400, now);
    }
    try {
      await db.callProcedure(
        'sp_save_shift',
        dtrId,
        values.user_id,
        values.time_in,
        values.time_out,
        values.note,
        rules.shift_start,
        rules.grace,
        rules.shift_hours,
        rules.max_hours,
        null,
      );
      flash(req, 'success', 'Shift updated.');
      return res.redirect(urlFor('attendance.everyone'));
    } catch (error) {
      flash(req, 'error', error.message);
      return shiftForm(req, res, { dtr_id: dtrId, ...req.body }, await staffChoices(req), 400, now);
    }
  });

  router.get('/attendance/overtime', 'attendance.overtime', roleRequired('AD'), async (req, res) => {
    const range = rangeOrFlash(req, req.query);
    const userId = staffIdOrFlash(req, req.query.user_id);
    let rows = [];
    let staff = [];
    try {
      [rows, staff] = await Promise.all([
        db.callFunction('fn_list_overtime', isoDate(range.start), isoDate(range.end)),
        db.callFunction('fn_list_staff'),
      ]);
    } catch (error) {
      flash(req, 'error', error.message);
    }
    if (userId) rows = rows.filter((row) => Number(row.user_id) === userId);
    return renderPage(req, res, 'overtime.html', {
      tab: 'overtime',
      start: range.start,
      end: range.end,
      staff: activeStaff(staff),
      user_id: userId || '',
      rows,
    });
  });

  router.get('/attendance/overtime/new', 'attendance.new_overtime', roleRequired('AD'), async (req, res) => {
    const rules = await shiftRules(req);
    let staff = [];
    try {
      staff = await db.callFunction('fn_list_staff');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return overtimeForm(req, res, overtimeDefaults(rules), staff, false);
  });

  router.post('/attendance/overtime/new', 'attendance.new_overtime', roleRequired('AD'), async (req, res) => {
    const rules = await shiftRules(req);
    let values;
    try {
      values = readOvertimeInput(req.body, null, rules.grace);
    } catch (error) {
      flash(req, 'error', error.message);
      return overtimeForm(req, res, { permit_id: null, ...req.body }, await staffChoices(req), false, 400);
    }
    try {
      await db.callProcedure(
        'sp_allow_overtime',
        req.session.user_id,
        values.user_id,
        values.work_date,
        values.start_time,
        values.end_time,
        values.grace_minutes,
        values.note,
        null,
      );
      flash(req, 'success', 'Overtime allowed.');
      return res.redirect(urlFor('attendance.overtime'));
    } catch (error) {
      flash(req, 'error', error.message);
      return overtimeForm(req, res, { permit_id: null, ...req.body }, await staffChoices(req), false, 400);
    }
  });

  router.get('/attendance/overtime/:permit_id(\\d+)', 'attendance.edit_overtime', roleRequired('AD'), async (req, res) => {
    const permitId = Number(req.params.permit_id);
    let permit = null;
    let staff = [];
    try {
      [permit, staff] = await Promise.all([
        db.callFunctionOne('fn_get_overtime', permitId),
        db.callFunction('fn_list_staff'),
      ]);
    } catch (error) {
      flash(req, 'error', error.message);
      return res.redirect(urlFor('attendance.overtime'));
    }
    if (!permit) {
      flash(req, 'error', 'That overtime permit does not exist.');
      return res.redirect(urlFor('attendance.overtime'));
    }
    await shiftRules(req);
    return overtimeForm(req, res, overtimeFormValue(permit), staff, true);
  });

  router.post('/attendance/overtime/:permit_id(\\d+)', 'attendance.edit_overtime', roleRequired('AD'), async (req, res) => {
    const permitId = Number(req.params.permit_id);
    const rules = await shiftRules(req);
    let existing = null;
    try {
      existing = await db.callFunctionOne('fn_get_overtime', permitId);
    } catch (error) {
      flash(req, 'error', error.message);
      return res.redirect(urlFor('attendance.overtime'));
    }
    if (!existing) {
      flash(req, 'error', 'That overtime permit does not exist.');
      return res.redirect(urlFor('attendance.overtime'));
    }
    let values;
    try {
      values = readOvertimeInput(req.body, existing, rules.grace);
    } catch (error) {
      flash(req, 'error', error.message);
      const permit = overtimeFormValue({ ...existing, ...req.body });
      return overtimeForm(req, res, permit, await staffChoices(req), true, 400);
    }
    try {
      await db.callProcedure(
        'sp_update_overtime',
        permitId,
        values.start_time,
        values.end_time,
        values.grace_minutes,
        values.note,
      );
      flash(req, 'success', existing.started ? 'Overtime end extended.' : 'Overtime updated.');
      return res.redirect(urlFor('attendance.overtime'));
    } catch (error) {
      flash(req, 'error', error.message);
      const permit = overtimeFormValue({ ...existing, ...req.body });
      return overtimeForm(req, res, permit, await staffChoices(req), true, 400);
    }
  });

  router.post('/attendance/overtime/:permit_id(\\d+)/cancel', 'attendance.cancel_overtime', roleRequired('AD'), async (req, res) => {
    try {
      await db.callProcedure('sp_cancel_overtime', Number(req.params.permit_id));
      flash(req, 'success', 'Overtime cancelled.');
    } catch (error) {
      flash(req, 'error', error.message);
    }
    return res.redirect(urlFor('attendance.overtime'));
  });

  router.get('/attendance/schedule', 'attendance.schedule', roleRequired('AD'), async (req, res) => {
    const rules = await shiftRules(req);
    return renderPage(req, res, 'schedule.html', scheduleView(rules));
  });

  router.post('/attendance/schedule', 'attendance.schedule', roleRequired('AD'), async (req, res) => {
    const rules = await shiftRules(req);
    let values;
    try {
      values = readScheduleInput(req.body);
    } catch (error) {
      flash(req, 'error', error.message);
      return renderPage(req, res, 'schedule.html', {
        tab: 'schedule',
        s: {
          shift_start: String(req.body.shift_start || rules.shift_start).slice(0, 5),
          shift_end: String(req.body.shift_end || rules.shift_end).slice(0, 5),
          grace_minutes: req.body.grace_minutes ?? rules.grace,
        },
      }, 400);
    }
    try {
      await db.callProcedure('sp_save_shift_setting', values.shift_start, values.shift_end, values.grace_minutes);
      flash(req, 'success', 'Schedule saved.');
      return res.redirect(urlFor('attendance.schedule'));
    } catch (error) {
      flash(req, 'error', error.message);
      return renderPage(req, res, 'schedule.html', { tab: 'schedule', s: req.body }, 400);
    }
  });
}
