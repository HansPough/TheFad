import { addDays, combine, hoursBetween, isoDate, isoweekday, parseTimestamp, roundHours, shopNow, shopTimestamp, startOfShopDay } from '../../time.js';
import { toInt, ValidationError } from '../../utils.js';

const hhmm = (value) => String(value || '').slice(0, 5);
const inputTimestamp = (value) => shopTimestamp(value).slice(0, 16);

export function readDate(value, label) {
  const text = String(value ?? '').trim();
  const parsed = parseTimestamp(text);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !parsed || isoDate(parsed) !== text) {
    throw new ValidationError(`Enter a valid ${label.toLowerCase()}.`);
  }
  return parsed;
}

export function readRange(query, now = shopNow()) {
  const start = query.start ? readDate(query.start, 'From date') : startOfShopDay(addDays(now, -30));
  const end = query.end ? readDate(query.end, 'To date') : startOfShopDay(now);
  if (start > end) throw new ValidationError('The From date must be on or before the To date.');
  return { start, end };
}

export function readTime(value, label) {
  const text = String(value ?? '').trim();
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  if (!match) throw new ValidationError(`Enter a valid ${label.toLowerCase()}.`);
  return `${match[1]}:${match[2]}:${match[3] || '00'}`;
}

export function readTimestamp(value, label, now = shopNow()) {
  const text = String(value ?? '').trim();
  const match = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.exec(text);
  const parsed = parseTimestamp(text);
  if (!match || !parsed || Number.isNaN(parsed.getTime()) || isoDate(parsed) !== text.slice(0, 10)) {
    throw new ValidationError(`Enter a valid ${label.toLowerCase()}.`);
  }
  return { value: parsed, text: shopTimestamp(parsed) };
}

function workdays(rules) {
  return new Set(String(rules.work_days || '').split(',').map((day) => Number(day.trim())).filter(Boolean));
}

export function nextShift(now, rules, todayDone) {
  const days = workdays(rules);
  let day = startOfShopDay(now);
  const todayEnd = combine(day, rules.shift_end);
  if (todayDone || now >= todayEnd || !days.has(isoweekday(day))) {
    for (let offset = 1; offset <= 7; offset += 1) {
      const candidate = addDays(day, offset);
      if (days.has(isoweekday(candidate))) {
        day = candidate;
        break;
      }
    }
  }
  const label = isoDate(day) === isoDate(now)
    ? 'Today'
    : isoDate(day) === isoDate(addDays(now, 1)) ? 'Tomorrow' : day.strftime('%a, %b %d');
  return {
    date: day,
    label,
    start: combine(day, rules.shift_start),
    end: combine(day, rules.shift_end),
  };
}

export function attendanceView(rows, permits, rules, access, now = shopNow()) {
  const sorted = [...rows].sort((left, right) => right.time_in - left.time_in);
  const openRow = sorted.find((row) => row.shift_type === 'Regular' && !row.time_out) || null;
  const today = isoDate(now);
  const todayDone = sorted.some((row) => row.shift_type === 'Regular' && row.time_out && isoDate(row.time_in) === today);
  const shiftHours = Number(rules.shift_hours) || 8;
  let st = null;
  if (openRow) {
    const opensAt = access?.shift_end || combine(openRow.time_in, rules.shift_end);
    const worked = Math.max(0, hoursBetween(openRow.time_in, now < opensAt ? now : opensAt));
    st = {
      worked,
      pct: Math.min(100, Math.round((worked / shiftHours) * 100)),
      opens_at: opensAt,
    };
  }

  const todayPermit = permits.find((permit) => isoDate(permit.work_date) === today) || null;
  let ot = null;
  if (todayPermit) {
    const start = combine(todayPermit.work_date, todayPermit.start_time);
    const end = combine(todayPermit.work_date, todayPermit.end_time);
    const graceUntil = new Date(start.getTime() + (Number(todayPermit.grace_minutes) || 0) * 60000);
    let state = 'ready';
    if ((todayPermit.time_in && !todayPermit.time_out) || todayPermit.status === 'In progress') state = 'open';
    else if (todayPermit.time_out || todayPermit.status === 'Done') state = 'done';
    else if (now > end) state = 'over';
    else if (now < start) state = 'early';
    else if (openRow) state = 'wait';
    ot = { start, end, grace_until: graceUntil, state, late: now > graceUntil };
  }

  return {
    tab: 'mine',
    rows: sorted,
    open_row: openRow,
    st,
    shift: shiftHours,
    today_done: todayDone,
    can_clock_in: Boolean(access?.can_clock_in) && !openRow && !todayDone,
    ot,
    permit: todayPermit,
    upcoming: permits
      .filter((permit) => isoDate(permit.work_date) > today)
      .map((permit) => ({ work_date: permit.work_date, start_time: permit.start_time, end_time: permit.end_time })),
    next_shift: nextShift(now, rules, todayDone),
  };
}

export function attendanceBoardView(rows, userId) {
  const filtered = userId ? rows.filter((row) => Number(row.user_id) === Number(userId)) : rows;
  const counts = { Present: 0, Late: 0, Absent: 0 };
  let hours = 0;
  let overtime = 0;
  for (const row of filtered) {
    if (row.status === 'Present') counts.Present += 1;
    else if (row.status === 'Late') counts.Late += 1;
    else if (row.status === 'Absent' || row.status === 'Not in yet') counts.Absent += 1;
    if (row.shift_type === 'Regular') hours += Number(row.total_hours) || 0;
    overtime += Number(row.overtime_hours) || 0;
  }
  return { rows: filtered, counts, hours, overtime };
}

export function shiftDefaults(rules, now = shopNow()) {
  const days = workdays(rules);
  let day = startOfShopDay(now);
  if (now < combine(day, rules.shift_end)) day = addDays(day, -1);
  while (!days.has(isoweekday(day))) day = addDays(day, -1);
  const date = isoDate(day);
  return {
    dtr_id: null,
    user_id: '',
    time_in: `${date}T${hhmm(rules.shift_start)}`,
    time_out: `${date}T${hhmm(rules.shift_end)}`,
    note: '',
  };
}

export function shiftFormValue(record) {
  return {
    ...record,
    time_in: inputTimestamp(record.time_in),
    time_out: record.time_out ? inputTimestamp(record.time_out) : '',
  };
}

export function readShiftInput(body, now = shopNow()) {
  const userId = toInt(body.user_id, 'Staff member');
  if (userId <= 0) throw new ValidationError('Choose a staff member.');
  const timeIn = readTimestamp(body.time_in, 'Time in', now);
  const timeOut = readTimestamp(body.time_out, 'Time out', now);
  if (timeOut.value <= timeIn.value) throw new ValidationError('Time out must be after time in.');
  if (timeOut.value > now) throw new ValidationError('The time out cannot be in the future.');
  const note = String(body.note ?? '').trim();
  if (note.length < 3) throw new ValidationError('Enter a reason of at least 3 characters.');
  if (note.length > 200) throw new ValidationError('Reason cannot be longer than 200 characters.');
  return { user_id: userId, time_in: timeIn.text, time_out: timeOut.text, note };
}

export function overtimeDefaults(rules, now = shopNow()) {
  return {
    permit_id: null,
    user_id: '',
    work_date: isoDate(now),
    start_time: '18:00',
    end_time: '21:00',
    grace_minutes: Number(rules.grace) || 0,
    note: '',
  };
}

export function overtimeFormValue(record) {
  return {
    ...record,
    work_date: isoDate(record.work_date),
    start_time: hhmm(record.start_time),
    end_time: hhmm(record.end_time),
  };
}

export function readOvertimeInput(body, existing, defaultGrace, now = shopNow()) {
  const userId = existing ? Number(existing.user_id) : toInt(body.user_id, 'Staff member');
  if (userId <= 0) throw new ValidationError('Choose a staff member.');
  const workDate = existing ? isoDate(existing.work_date) : isoDate(readDate(body.work_date, 'Work date'));
  if (workDate < isoDate(now)) throw new ValidationError('Overtime cannot be allowed for a past date.');
  const requestedStart = readTime(body.start_time, 'Overtime start');
  const endTime = readTime(body.end_time, 'Overtime end');
  if (existing?.started && hhmm(requestedStart) !== hhmm(existing.start_time)) {
    throw new ValidationError('After overtime starts, only the end time can be extended.');
  }
  const startTime = existing?.started ? String(existing.start_time).slice(0, 8) : requestedStart;
  const start = combine(workDate, startTime);
  const end = combine(workDate, endTime);
  const duration = hoursBetween(start, end);
  if (duration <= 0 || duration > 8) throw new ValidationError('Overtime must be longer than 0 hours and no more than 8 hours.');
  const graceText = String(body.grace_minutes ?? '').trim();
  const graceMinutes = graceText ? toInt(graceText, 'Grace minutes') : (existing ? null : Number(defaultGrace) || 0);
  if (graceMinutes !== null && (graceMinutes < 0 || graceMinutes > 120)) {
    throw new ValidationError('Grace minutes must be between 0 and 120.');
  }
  const note = String(body.note ?? '').trim();
  if (note.length > 200) throw new ValidationError('Reason cannot be longer than 200 characters.');
  if (existing?.started && note.length < 3) throw new ValidationError('Enter a reason of at least 3 characters for the extension.');
  return {
    user_id: userId,
    work_date: workDate,
    start_time: startTime,
    end_time: endTime,
    grace_minutes: graceMinutes,
    note: note || null,
  };
}

export function readScheduleInput(body) {
  const shiftStart = readTime(body.shift_start, 'Time in');
  const shiftEnd = readTime(body.shift_end, 'Time out');
  const duration = hoursBetween(combine('2000-01-01', shiftStart), combine('2000-01-01', shiftEnd));
  if (duration <= 0 || duration > 12) throw new ValidationError('The regular shift must be between 1 and 12 hours.');
  const graceMinutes = toInt(body.grace_minutes, 'Grace minutes');
  if (graceMinutes < 0 || graceMinutes > 120) throw new ValidationError('Grace minutes must be between 0 and 120.');
  return { shift_start: shiftStart, shift_end: shiftEnd, grace_minutes: graceMinutes };
}

export function scheduleView(rules) {
  return {
    tab: 'schedule',
    s: {
      shift_start: hhmm(rules.shift_start),
      shift_end: hhmm(rules.shift_end),
      grace_minutes: Number(rules.grace),
    },
  };
}

export function roundedHours(value) {
  return roundHours(Number(value) || 0);
}
