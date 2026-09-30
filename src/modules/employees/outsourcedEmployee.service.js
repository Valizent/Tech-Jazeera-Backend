import OutsourcedEmployee from './outsourcedEmployee.model.js';
import ApiError from '../../utils/ApiError.js';
import { escapeRegex } from '../../utils/escapeRegex.js';

export async function listOutsourcedEmployees({ search, workerType, limit = 100 }) {
  const filter = {};
  if (search) filter.name = { $regex: escapeRegex(search), $options: 'i' };
  if (workerType) filter.workerType = workerType;

  return OutsourcedEmployee.find(filter)
    .sort({ name: 1 })
    .limit(limit)
    .populate('subcontractor', 'name')
    .lean();
}

export async function getOutsourcedEmployee(id) {
  const employee = await OutsourcedEmployee.findById(id).populate('subcontractor', 'name').lean();
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');
  return employee;
}

export async function createOutsourcedEmployee(data, actor) {
  const employee = await OutsourcedEmployee.create({
    ...data,
    createdBy: actor.userId,
  });
  return employee.toObject();
}

export async function updateOutsourcedEmployee(id, data) {
  const employee = await OutsourcedEmployee.findByIdAndUpdate(id, data, { new: true, runValidators: true }).populate('subcontractor', 'name').lean();
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');
  return employee;
}

export async function deleteOutsourcedEmployee(id) {
  const employee = await OutsourcedEmployee.findByIdAndDelete(id);
  if (!employee) throw new ApiError(404, 'Outsourced employee not found');
  return employee;
}
