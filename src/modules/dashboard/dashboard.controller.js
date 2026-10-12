/**
 * Dashboard controller — HTTP translation only.
 */
import ApiResponse from '../../utils/ApiResponse.js';
import { getDashboard } from './dashboard.service.js';
import { getDashboardInsights } from './dashboardInsights.service.js';

/**
 * GET /api/dashboard?thresholdDays=  — 200 → data: the full rolled-up overview.
 * A Coordinator sees their own team throughout — deployments, workforce
 * counts, payroll, clients, expiring documents, and activity. Every other
 * role sees the full company-wide overview.
 */
export async function overview(req, res) {
  const data = await getDashboard({
    thresholdDays: req.query.thresholdDays,
    actor: { role: req.user.role, userId: req.user.id },
  });
  res.json(new ApiResponse('Dashboard.', data));
}

/** GET /api/dashboard/insights — the "look at today" blocks, each null unless the viewer holds its Read. */
export async function insights(req, res) {
  const data = await getDashboardInsights({ role: req.user.role, userId: req.user.id });
  res.json(new ApiResponse('Dashboard insights.', data));
}

export async function standbyAnalysis(req, res) {
  const data = await import('./dashboard.service.js').then((s) => s.getStandbyAnalysis({ role: req.user.role, userId: req.user.id }));
  res.json(new ApiResponse('Standby workforce analysis.', data));
}

export async function coordinatorDrillDown(req, res) {
  const data = await import('./dashboard.service.js').then((s) =>
    s.getCoordinatorDrillDown({ role: req.user.role, userId: req.user.id }, req.params.id, req.query.month)
  );
  res.json(new ApiResponse('Coordinator drill-down.', data));
}

export async function coordinatorLeaderboard(req, res) {
  const data = await import('./dashboard.service.js').then((s) =>
    s.getCoordinatorLeaderboard({ role: req.user.role, userId: req.user.id }, req.query.month)
  );
  res.json(new ApiResponse('Coordinator leaderboard.', data));
}
