/**
 * approvalEscalation.job.test.js - the escalation matrix: levels on a workflow step tell the step's approver or a
 * role after N days, once each, never before their day, never for a decided request; a request filed before the
 * levels existed is chased by the live workflow's levels.
 */
import mongoose from 'mongoose';
import User from '../auth/user.model.js';
import ApprovalRole from '../approvals/approvalRole.model.js';
import ApprovalWorkflow from '../approvals/approvalWorkflow.model.js';
import Client from '../clients/client.model.js';
import Notification from './notification.model.js';
import { runApprovalEscalationCheck } from './approvalEscalation.job.js';

const DAY = 86_400_000;
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const login = (role) => User.create({ name: `${role} ${unique()}`, email: `${role.toLowerCase()}-${unique()}@example.com`, passwordHash: 'x', role });
const daysAgo = (n) => new Date(Date.now() - n * DAY - 3_600_000);
const received = (user) => Notification.countDocuments({ user: user._id });

async function setup() {
  const [approver, second, boss] = await Promise.all([login('HR'), login('HR'), login('Executive')]);
  const reviewers = await ApprovalRole.create({ name: `Reviewers ${unique()}`, members: [approver._id, second._id] });
  const seniors = await ApprovalRole.create({ name: `Seniors ${unique()}`, members: [boss._id] });
  const escalation = [
    { afterDays: 2, notify: 'approver' },
    { afterDays: 4, notify: 'role', role: seniors._id },
  ];
  const workflow = await ApprovalWorkflow.create({
    name: `Flow ${unique()}`,
    appliesTo: ['ClientApproval'],
    steps: [{ label: 'Check', roles: [reviewers._id], escalation }],
  });
  const waiting = (extra = {}) =>
    Client.create({
      companyName: `Client ${unique()}`,
      approvalStatus: 'Pending',
      workflow: workflow._id,
      workflowName: workflow.name,
      steps: [{ label: 'Check', roles: [reviewers._id], assignee: approver._id, escalation }],
      currentStep: 0,
      currentStepEnteredAt: daysAgo(3),
      createdBy: new mongoose.Types.ObjectId(),
      ...extra,
    });
  return { approver, second, boss, reviewers, seniors, workflow, waiting, escalation };
}

describe('approval escalation', () => {
  it('tells the assigned approver after 2 days (not the rest of the role), once, and the role only after 4', async () => {
    const { approver, second, boss, waiting } = await setup();
    const request = await waiting();

    const first = await runApprovalEscalationCheck();
    expect(first.notificationsSent).toBe(1);
    expect(await received(approver)).toBe(1);
    expect(await received(second)).toBe(0);
    expect(await received(boss)).toBe(0);

    expect((await runApprovalEscalationCheck()).notificationsSent).toBe(0); // never twice

    await Client.updateOne({ _id: request._id }, { currentStepEnteredAt: daysAgo(5) });
    const later = await runApprovalEscalationCheck();
    // the clock moved, so level 1 and level 2 both fire for this visit; the approver is told again for the new visit
    expect(later.notificationsSent).toBe(2);
    expect(await received(boss)).toBe(1);
    expect(await received(approver)).toBe(2);
  });

  it('does nothing before the first level, or for a request that is already decided', async () => {
    const { approver, waiting } = await setup();
    await waiting({ currentStepEnteredAt: daysAgo(1) });
    await waiting({ approvalStatus: 'Approved', currentStepEnteredAt: daysAgo(10) });
    const result = await runApprovalEscalationCheck();
    expect(result.notificationsSent).toBe(0);
    expect(await received(approver)).toBe(0);
  });

  it('chases a request filed before the levels existed using the live workflow', async () => {
    const { approver, waiting, reviewers } = await setup();
    await waiting({
      steps: [{ label: 'Check', roles: [reviewers._id], assignee: approver._id }], // no escalation in the frozen copy
      currentStepEnteredAt: daysAgo(3),
    });
    const result = await runApprovalEscalationCheck();
    expect(result.notificationsSent).toBe(1);
    expect(await received(approver)).toBe(1);
  });
});
