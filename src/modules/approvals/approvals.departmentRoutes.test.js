/**
 * approvals.departmentRoutes.test.js - 2026-10-13: a default workflow may route
 * by the employee's department (annual vacation: Accounts -> FM, others -> MM).
 */
import ApprovalRole from './approvalRole.model.js';
import ApprovalWorkflow from './approvalWorkflow.model.js';
import { createApprovalWorkflow, updateApprovalWorkflow, resolveApprovalWorkflow } from './approvals.service.js';
import { normalizeDepartment, EMPLOYEE_DEPARTMENTS } from '../employees/departments.js';

const actor = { userId: '000000000000000000000001', ip: '127.0.0.1' };
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function setup() {
  const hr = await ApprovalRole.create({ name: `HR ${unique()}`, members: [] });
  const mm = await ApprovalRole.create({ name: `MM ${unique()}`, members: [] });
  const fm = await ApprovalRole.create({ name: `FM ${unique()}`, members: [] });
  const step = (r) => ({ roles: [r._id.toString()] });
  const accounts = await createApprovalWorkflow({ name: `Vacation Accounts ${unique()}`, steps: [step(hr), step(fm)], appliesTo: [] }, actor);
  const standard = await createApprovalWorkflow(
    {
      name: `Vacation Standard ${unique()}`,
      steps: [step(hr), step(mm)],
      appliesTo: ['AnnualVacation'],
      departmentRoutes: [{ department: 'Accounts', workflow: accounts._id.toString() }],
    },
    actor
  );
  return { accounts, standard };
}

describe('normalizeDepartment', () => {
  it('reads the clear cases and leaves the rest alone', () => {
    expect(normalizeDepartment('accounts')).toBe('Accounts');
    expect(normalizeDepartment('  Accounting ')).toBe('Accounts');
    expect(normalizeDepartment('Finance')).toBe('Accounts');
    expect(normalizeDepartment('human resources')).toBe('HR');
    expect(normalizeDepartment('Workshop')).toBeNull();
    expect(normalizeDepartment('')).toBeNull();
    expect(normalizeDepartment(undefined)).toBeNull();
    expect(EMPLOYEE_DEPARTMENTS).toContain('Marketing');
  });
});

describe('resolveApprovalWorkflow with department routes', () => {
  it('sends an Accounts employee to the routed workflow and everyone else to the default', async () => {
    const { accounts, standard } = await setup();
    const inAccounts = await resolveApprovalWorkflow({ department: 'Accounts' }, 'AnnualVacation');
    const loosely = await resolveApprovalWorkflow({ department: 'accounting' }, 'AnnualVacation');
    const marketing = await resolveApprovalWorkflow({ department: 'Marketing' }, 'AnnualVacation');
    const unknown = await resolveApprovalWorkflow({ department: 'Workshop' }, 'AnnualVacation');
    const none = await resolveApprovalWorkflow({}, 'AnnualVacation');

    expect(String(inAccounts._id)).toBe(String(accounts._id));
    expect(String(loosely._id)).toBe(String(accounts._id));
    for (const w of [marketing, unknown, none]) expect(String(w._id)).toBe(String(standard._id));
  });

  it('a per-employee override still wins over a department route', async () => {
    const { standard } = await setup();
    const other = await ApprovalWorkflow.create({ name: `Override ${unique()}`, steps: standard.steps, appliesTo: [] });
    const w = await resolveApprovalWorkflow(
      { department: 'Accounts', approvalOverrides: [{ requestType: 'AnnualVacation', workflow: other._id }] },
      'AnnualVacation'
    );
    expect(String(w._id)).toBe(String(other._id));
  });

  it('falls back to the default when the routed workflow is deactivated', async () => {
    const { accounts, standard } = await setup();
    await updateApprovalWorkflow(accounts._id.toString(), { isActive: false }, actor);
    const w = await resolveApprovalWorkflow({ department: 'Accounts' }, 'AnnualVacation');
    expect(String(w._id)).toBe(String(standard._id));
  });

  it('allows several active non-default workflows, but still only one default per request type', async () => {
    const role = await ApprovalRole.create({ name: `R ${unique()}`, members: [] });
    const steps = [{ roles: [role._id.toString()] }];
    await createApprovalWorkflow({ name: `Override A ${unique()}`, steps, appliesTo: [] }, actor);
    await createApprovalWorkflow({ name: `Override B ${unique()}`, steps, appliesTo: [] }, actor);
    await createApprovalWorkflow({ name: `Default one ${unique()}`, steps, appliesTo: ['Leave'] }, actor);
    await expect(createApprovalWorkflow({ name: `Default two ${unique()}`, steps, appliesTo: ['Leave'] }, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('refuses routes on a workflow that is not a default, to itself, or to a missing workflow', async () => {
    const { accounts } = await setup();
    const role = await ApprovalRole.create({ name: `R ${unique()}`, members: [] });
    const steps = [{ roles: [role._id.toString()] }];
    await expect(
      createApprovalWorkflow({ name: `NoDefault ${unique()}`, steps, appliesTo: [], departmentRoutes: [{ department: 'IT', workflow: accounts._id.toString() }] }, actor)
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      createApprovalWorkflow(
        { name: `Missing ${unique()}`, steps, appliesTo: ['Leave'], departmentRoutes: [{ department: 'IT', workflow: '000000000000000000000009' }] },
        actor
      )
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
