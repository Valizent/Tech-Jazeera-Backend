/**
 * Expense controller — HTTP translation. The receipt endpoint streams bytes
 * (not the JSON envelope), same pattern as reimbursement claims/documents.
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ApiError from '../../utils/ApiError.js';
import ApiResponse from '../../utils/ApiResponse.js';
import { contentDisposition } from '../../utils/contentDisposition.js';
import * as expenseService from './expense.service.js';

const actor = (req) => ({ userId: req.user.id, ip: req.ip });
const viewer = (req) => ({ userId: req.user.id, role: req.user.role });

export async function list(req, res) {
  const data = await expenseService.listExpenses(req.query, viewer(req));
  res.json(new ApiResponse('Expenses.', data));
}

export async function summary(req, res) {
  const data = await expenseService.getSummary(req.query, viewer(req));
  res.json(new ApiResponse('Expense summary.', data));
}

export async function get(req, res) {
  const expense = await expenseService.getExpense(req.params.id);
  res.json(new ApiResponse('Expense.', expense));
}

export async function create(req, res) {
  const expense = await expenseService.createExpense(req.body, req.file, actor(req));
  res.status(201).json(new ApiResponse('Expense recorded.', expense));
}

export async function update(req, res) {
  const expense = await expenseService.updateExpense(req.params.id, req.body, actor(req));
  res.json(new ApiResponse('Expense updated.', expense));
}

export async function remove(req, res) {
  await expenseService.deleteExpense(req.params.id, actor(req));
  res.json(new ApiResponse('Expense deleted.'));
}

export async function receipt(req, res) {
  const fileData = await expenseService.getReceiptFile(req.params.id);
  res.setHeader('Content-Type', fileData.mimeType);
  res.setHeader('Content-Disposition', contentDisposition(fileData.originalName));
  const upstream = await fetch(fileData.url);
  if (!upstream.ok || !upstream.body) {
    throw new ApiError(410, 'The stored receipt is no longer available.');
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}
