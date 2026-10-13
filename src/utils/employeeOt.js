/**
 * What an Own employee's overtime hour costs: their monthly salary spread over
 * their contract hours for the month, at 1.5 times (2026-10-13, the user's own
 * rule). Both figures live on the Employee record; either missing means there
 * is no such rate (null) and the caller falls back to whatever was typed on
 * the mobilisation, which is what every record before this rule carries.
 *
 * Not rounded: a month's OT cost rounds once, after multiplying by the hours.
 */
export const EMPLOYEE_OT_MULTIPLIER = 1.5;

export function ownEmployeeOtRate(salary, contractHours) {
  if (!(Number(salary) > 0) || !(Number(contractHours) > 0)) return null;
  return (Number(salary) / Number(contractHours)) * EMPLOYEE_OT_MULTIPLIER;
}
