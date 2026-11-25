import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attendanceBoardView,
  attendanceView,
  nextShift,
  readOvertimeInput,
  readRange,
  readScheduleInput,
  readShiftInput,
  readTimestamp,
} from '../backend/decembrano/attendance-service.js';
import { isoDate } from '../time.js';
import { ValidationError } from '../utils.js';

const at = (text) => new Date(`${text}+08:00`);
const rules = {
  shift_start: '09:00:00',
  shift_end: '17:00:00',
  grace: 15,
  shift_hours: 8,
  max_hours: 12,
  work_days: '1,2,3,4,5,6',
};

test('date ranges default to the last 30 days and reject reversed ranges', () => {
  const now = at('2026-11-24T10:00:00');
  const range = readRange({}, now);
  assert.equal(isoDate(range.start), '2026-10-25');
  assert.equal(isoDate(range.end), '2026-11-24');
  assert.throws(() => readRange({ start: '2026-11-24', end: '2026-11-23' }, now), ValidationError);
});

test('timestamps reject impossible calendar dates', () => {
  assert.throws(() => readTimestamp('2026-02-30T09:00', 'Time in'), ValidationError);
  assert.equal(readTimestamp('2026-11-24T09:15', 'Time in').text, '2026-11-24T09:15:00');
});

test('the next shift skips closed weekdays', () => {
  const next = nextShift(at('2026-11-29T12:00:00'), rules, false);
  assert.equal(next.label, 'Tomorrow');
  assert.equal(isoDate(next.date), '2026-11-30');
  assert.equal(next.start.toISOString(), '2026-11-30T01:00:00.000Z');
});

test('open overtime is not treated as an open regular shift', () => {
  const now = at('2026-11-24T19:00:00');
  const rows = [{
    shift_type: 'Overtime',
    time_in: at('2026-11-24T18:30:00'),
    time_out: null,
    total_hours: null,
    status: 'Present',
  }];
  const permits = [{
    permit_id: 4,
    work_date: at('2026-11-24T00:00:00'),
    start_time: '18:00:00',
    end_time: '21:00:00',
    grace_minutes: 15,
    time_in: at('2026-11-24T18:30:00'),
    time_out: null,
  }];
  const view = attendanceView(rows, permits, rules, { can_clock_in: false }, now);
  assert.equal(view.open_row, null);
  assert.equal(view.ot.state, 'open');
  assert.equal(view.can_clock_in, false);
});

test('overtime status is used when time fields are unavailable', () => {
  const view = attendanceView([], [{
    work_date: at('2026-11-24T00:00:00'),
    start_time: '18:00:00',
    end_time: '21:00:00',
    grace_minutes: 15,
    status: 'Done',
  }], rules, { can_clock_in: true }, at('2026-11-24T22:00:00'));
  assert.equal(view.ot.state, 'done');
});

test('shift corrections require ordered past times and a reason', () => {
  const now = at('2026-11-24T11:00:00');
  const valid = {
    user_id: '2',
    time_in: '2026-11-24T09:00',
    time_out: '2026-11-24T10:00',
    note: 'Forgot to clock in',
  };
  assert.equal(readShiftInput(valid, now).time_out, '2026-11-24T10:00:00');
  assert.throws(() => readShiftInput({ ...valid, time_out: '2026-11-24T12:00' }, now), ValidationError);
  assert.throws(() => readShiftInput({ ...valid, note: 'x' }, now), ValidationError);
});

test('started overtime can only extend its end with a reason', () => {
  const existing = {
    user_id: 2,
    work_date: at('2026-11-24T00:00:00'),
    start_time: '18:00:00',
    end_time: '21:00:00',
    started: true,
  };
  const body = {
    start_time: '18:00',
    end_time: '22:00',
    grace_minutes: '15',
    note: 'Closing count',
  };
  const now = at('2026-11-24T20:00:00');
  assert.equal(readOvertimeInput(body, existing, 15, now).end_time, '22:00:00');
  assert.equal(readOvertimeInput(body, { ...existing, start_time: '18:00:30' }, 15, now).start_time, '18:00:30');
  assert.throws(() => readOvertimeInput({ ...body, start_time: '19:00' }, existing, 15, now), ValidationError);
  assert.throws(() => readOvertimeInput({ ...body, note: '' }, existing, 15, now), ValidationError);
});

test('schedule and attendance totals enforce the SQL limits', () => {
  assert.deepEqual(
    readScheduleInput({ shift_start: '09:00', shift_end: '17:00', grace_minutes: '15' }),
    { shift_start: '09:00:00', shift_end: '17:00:00', grace_minutes: 15 },
  );
  assert.throws(() => readScheduleInput({ shift_start: '09:00', shift_end: '22:00', grace_minutes: '15' }), ValidationError);
  const view = attendanceBoardView([
    { user_id: 2, shift_type: 'Regular', status: 'Present', total_hours: 8, overtime_hours: 0 },
    { user_id: 2, shift_type: 'Overtime', status: 'Late', total_hours: 2, overtime_hours: 2 },
    { user_id: 3, shift_type: 'Regular', status: 'Absent', total_hours: null, overtime_hours: null },
  ], 2);
  assert.deepEqual(view.counts, { Present: 1, Late: 1, Absent: 0 });
  assert.equal(view.hours, 8);
  assert.equal(view.overtime, 2);
});
