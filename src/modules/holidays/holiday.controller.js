/**
 * Holiday controller — HTTP translation only.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import * as holidayService from './holiday.service.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

/** GET /api/holidays — any authenticated user, including Workers. */
export async function list(req, res) {
  const holidays = await holidayService.listHolidays(req.query);
  res.json(new ApiResponse('Holidays.', holidays));
}

/** POST /api/holidays — Section Access 'holidays' write. */
export async function create(req, res) {
  const holiday = await holidayService.createHoliday(req.body, actor(req));
  res.status(201).json(new ApiResponse('Holiday created.', holiday));
}

/** PATCH /api/holidays/:id — Section Access 'holidays' write. */
export async function update(req, res) {
  const holiday = await holidayService.updateHoliday(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Holiday updated.', holiday));
}

/** DELETE /api/holidays/:id — Section Access 'holidays' write. */
export async function remove(req, res) {
  await holidayService.deleteHoliday(req.params.id, actor(req));
  res.json(new ApiResponse('Holiday deleted.', null));
}
