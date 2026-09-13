/**
 * Monthly timesheet report — the "real attendance" counterpart to the
 * Timesheet Processor's device-log report. Same day-by-day row shape
 * (Date/Day/Login/Logout/Worked/Required/Deficiency/Overtime/Status) and
 * the same .xlsx renderer (timesheetProcessor/timesheet.export.js), but
 * built from this employee's actual attendance for the whole month instead
 * of a parsed device file.
 *
 * Two real data sources, picked by `employee.type` (added 2026-09-13, when
 * this became the Monthly Report tab's own list+view — previously only ever
 * called for the on-site Outsourced/Subcontracted workforce): an 'Own'-type
 * internal staff member (Coordinator/HR/Manager/Accounts) never gets an
 * Employee-based Attendance record at all — they self-punch through the
 * separate User-keyed StaffAttendance collection instead (see
 * staffAttendance.model.js's own doc comment on why it's kept separate).
 * Everyone else (the deployed/mobilised field workforce) still reads
 * Employee-based Attendance exactly as before. A StaffAttendance day has no
 * `status` field — there's no Absent/Leave/Sick concept for a self-punch,
 * those go through the Leave module entirely — so `explicitStatus` is
 * simply null for that source and every day falls through to Holiday/Off/
 * No-Attendance/a real punch, same as an Attendance record with no special
 * status ever did.
 *
 * Mirrors two already-established rules elsewhere in the app rather than
 * inventing new ones:
 *  - Precedence for a day with no real record — a real record always wins;
 *    otherwise infer Holiday, then the employee's own weeklyOffDay — is
 *    EXACTLY RecordsGrid.jsx's markFor() logic.
 *  - A staff-marked Present day with no clock times counts as
 *    expectedDailyHours worked (never an invented default) — exactly
 *    timesheets/timesheet.service.js's computeTotals() rule.
 */
import Attendance from '../attendance/attendance.model.js';
import StaffAttendance from '../staffAttendance/staffAttendance.model.js';
import User from '../auth/user.model.js';
import Holiday from '../holidays/holiday.model.js';
import { minutesToHHMM, daysInMonth, weekdayShort } from '../timesheetProcessor/timesheet.time.js';
import { DEFAULT_REQUIRED_MINUTES } from '../timesheetProcessor/timesheet.constants.js';

const RIYADH_TZ = 'Asia/Riyadh'; // fixed UTC+3, no DST — safe to hardcode

/** Minute-of-day (0..1439), in Saudi local time, for a stored UTC instant.
 *  Needed because this runs server-side (unlike the rest of the app, which
 *  only ever renders these timestamps in the viewer's own browser timezone)
 *  — a naive server-local Date method would be wrong on a UTC-configured host. */
function riyadhMinutesOfDay(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: RIYADH_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hh = Number(parts.find((p) => p.type === 'hour').value);
  const mm = Number(parts.find((p) => p.type === 'minute').value);
  return hh * 60 + mm;
}

/** 0=Sun..6=Sat for a "YYYY-MM-DD" key, matching Employee.weeklyOffDay's convention. */
function dayOfWeek(dateKey) {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

/** The holiday (if any) covering this date key — same range-overlap check as RecordsGrid.jsx. */
function holidayFor(holidays, dateKey) {
  return (
    holidays.find(
      (h) => h.startDate.toISOString().slice(0, 10) <= dateKey && h.endDate.toISOString().slice(0, 10) >= dateKey
    ) ?? null
  );
}

/**
 * @param {object} employee  lean Employee doc (needs fullName, employeeId, weeklyOffDay, expectedDailyHours)
 * @param {{year:number, month:number}} period
 */
export async function buildMonthlyAttendanceReport(employee, { year, month }) {
  const totalDays = daysInMonth(year, month);
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month - 1, totalDays, 23, 59, 59));

  const isOwnStaff = employee.type === 'Own';
  const [records, holidays] = await Promise.all([
    isOwnStaff
      ? User.findOne({ employee: employee._id })
          .select('_id')
          .lean()
          .then((user) =>
            user
              ? StaffAttendance.find({ user: user._id, date: { $gte: periodStart, $lte: periodEnd } }).lean()
              : []
          )
      : Attendance.find({ employee: employee._id, date: { $gte: periodStart, $lte: periodEnd } }).lean(),
    Holiday.find({ startDate: { $lte: periodEnd }, endDate: { $gte: periodStart } }).lean(),
  ]);
  const byDate = new Map(records.map((r) => [r.date.toISOString().slice(0, 10), r]));

  const requiredMinutes =
    employee.expectedDailyHours != null ? Math.round(employee.expectedDailyHours * 60) : DEFAULT_REQUIRED_MINUTES;

  const rows = [];
  const summary = {
    workingDays: 0, // expected to work: excludes Holiday and Off days
    holidayDays: 0,
    offDays: 0, // weekly off — inferred, or explicitly marked
    presentDays: 0, // includes Present/Overtime/Deficient — any day with a real worked-hours figure
    absentDays: 0,
    leaveDays: 0,
    sickDays: 0,
    singlePunchDays: 0,
    noAttendanceDays: 0,
    totalWorkedMinutes: 0,
    totalRequiredMinutes: 0,
    totalDeficiencyMinutes: 0,
    totalOvertimeMinutes: 0,
  };

  for (let day = 1; day <= totalDays; day++) {
    const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const record = byDate.get(dateKey);
    const holiday = !record ? holidayFor(holidays, dateKey) : null;
    const isInferredOff =
      !record && !holiday && employee.weeklyOffDay != null && dayOfWeek(dateKey) === employee.weeklyOffDay;

    let login = null;
    let logout = null;
    let workedMinutes = 0;
    let requiredForDay = requiredMinutes;
    let status;

    if (holiday) {
      requiredForDay = 0;
      status = 'Holiday';
      summary.holidayDays += 1;
    } else if (isInferredOff) {
      requiredForDay = 0;
      status = 'Off';
      summary.offDays += 1;
    } else if (!record) {
      status = 'No Attendance';
      summary.noAttendanceDays += 1;
    } else if (record.status === 'Leave') {
      requiredForDay = 0;
      status = 'Leave';
      summary.leaveDays += 1;
    } else if (record.status === 'Sick') {
      requiredForDay = 0;
      status = 'Sick';
      summary.sickDays += 1;
    } else if (record.status === 'Off') {
      requiredForDay = 0;
      status = 'Off';
      summary.offDays += 1;
    } else if (record.status === 'Absent') {
      status = 'Absent';
      summary.absentDays += 1;
    } else {
      // 'Present'
      if (record.checkInTime) login = minutesToHHMM(riyadhMinutesOfDay(record.checkInTime));
      if (record.checkOutTime) logout = minutesToHHMM(riyadhMinutesOfDay(record.checkOutTime));

      if (record.checkInTime && !record.checkOutTime) {
        status = 'Single Punch';
        summary.singlePunchDays += 1;
      } else {
        // No clock times at all (a staff bulk-mark) → counts as exactly the
        // expected hours, never an invented default — same rule as
        // timesheets/timesheet.service.js's computeTotals().
        workedMinutes =
          record.hoursWorked != null
            ? Math.round(record.hoursWorked * 60)
            : (employee.expectedDailyHours ?? null) != null
              ? requiredForDay
              : 0;
        status = workedMinutes > requiredForDay ? 'Overtime' : workedMinutes < requiredForDay ? 'Deficient' : 'Present';
        summary.presentDays += 1;
      }
    }

    const deficiencyMinutes = Math.max(0, requiredForDay - workedMinutes);
    const overtimeMinutes = Math.max(0, workedMinutes - requiredForDay);
    if (requiredForDay > 0) summary.workingDays += 1;
    summary.totalWorkedMinutes += workedMinutes;
    summary.totalRequiredMinutes += requiredForDay;
    summary.totalDeficiencyMinutes += deficiencyMinutes;
    summary.totalOvertimeMinutes += overtimeMinutes;

    rows.push({
      date: dateKey,
      day: weekdayShort(year, month, day),
      login,
      logout,
      workedMinutes,
      requiredMinutes: requiredForDay,
      deficiencyMinutes,
      overtimeMinutes,
      status,
    });
  }

  const summaryLines = [
    ['Working Days', String(summary.workingDays)],
    ['Holidays', String(summary.holidayDays)],
    ['Weekly Off Days', String(summary.offDays)],
    ['Present Days', String(summary.presentDays)],
    ['Absent Days', String(summary.absentDays)],
    ['Leave Days', String(summary.leaveDays)],
    ['Sick Days', String(summary.sickDays)],
    ['Single Punch Days', String(summary.singlePunchDays)],
    ['No Attendance Days', String(summary.noAttendanceDays)],
    ['Total Worked Hours', minutesToHHMM(summary.totalWorkedMinutes)],
    ['Total Required Hours', minutesToHHMM(summary.totalRequiredMinutes)],
    ['Total Deficiency', minutesToHHMM(summary.totalDeficiencyMinutes)],
    ['Total Overtime', minutesToHHMM(summary.totalOvertimeMinutes)],
  ];

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  return {
    employee: { id: employee._id.toString(), fullName: employee.fullName, employeeId: employee.employeeId },
    month,
    year,
    monthName: monthNames[month - 1],
    requiredMinutes,
    generatedAt: new Date().toISOString(),
    rows,
    summary,
    summaryLines,
  };
}
