/** Decides whether a signed-in user may use the staff pages. */
import * as db from '../../db.js';

export async function getAccess(userId) {
  const staff = await db.callFunctionOne('fn_get_staff', userId);
  if (!staff) return null;
  if (!staff.is_active) {
    return { active: false, allowed: false, can_clock_in: false, user_type: staff.user_type };
  }
  const access = await db.callFunctionOne('fn_staff_access', userId);
  return {
    active: true,
    allowed: Boolean(access?.allowed),
    can_clock_in: Boolean(access?.can_clock_in),
    user_type: staff.user_type,
    shop_now: access?.shop_now || null,
    shift_end: access?.shift_end || null,
  };
}
