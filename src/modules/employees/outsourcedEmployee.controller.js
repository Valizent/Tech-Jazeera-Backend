import * as service from './outsourcedEmployee.service.js';
import ApiResponse from '../../utils/ApiResponse.js';

const actor = (req) => ({ userId: req.user.id, role: req.user.role, ip: req.ip });

export async function list(req, res) {
  const data = await service.listOutsourcedEmployees({
    search: req.query.search,
    workerType: req.query.workerType,
    limit: parseInt(req.query.limit, 10) || 100,
  });
  res.json(new ApiResponse('Outsourced employees retrieved.', data));
}

export async function get(req, res) {
  const data = await service.getOutsourcedEmployee(req.params.id);
  res.json(new ApiResponse('Outsourced employee retrieved.', data));
}

export async function create(req, res) {
  const data = await service.createOutsourcedEmployee(req.body, actor(req));
  res.status(201).json(new ApiResponse('Outsourced employee created.', data));
}

export async function update(req, res) {
  const data = await service.updateOutsourcedEmployee(req.params.id, req.body);
  res.json(new ApiResponse('Outsourced employee updated.', data));
}

export async function remove(req, res) {
  await service.deleteOutsourcedEmployee(req.params.id);
  res.json(new ApiResponse('Outsourced employee deleted.', null));
}
