/**
 * Reconciliation controller — HTTP translation only.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import { runReconciliation } from './reconciliation.service.js';

export async function run(req, res) {
  const report = await runReconciliation();
  res.json(new ApiResponse('Reconciliation report.', report));
}
