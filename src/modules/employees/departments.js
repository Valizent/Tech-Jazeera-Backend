/**
 * The departments an employee can belong to (2026-10-13, the user's decision:
 * Department becomes a fixed list instead of free text). Used by the employee
 * form, and by the approval engine to route a request by department (see
 * approvalWorkflow.model.js `departmentRoutes`).
 *
 * Employees saved before this was a list carry whatever was typed. They are
 * not rewritten: `normalizeDepartment` reads the clear cases ("accounts",
 * "Accounting", "Finance" -> Accounts) and anything else is treated as "no
 * department yet" for routing until HR picks one from the list.
 */
// 'Coordination' was dropped from the list on 2026-10-14 (the user's decision); anyone saved with it is read as "no
// department yet" until HR picks one of these.
export const EMPLOYEE_DEPARTMENTS = ['Accounts', 'Marketing', 'HR', 'Operations', 'Management', 'IT'];

const SYNONYMS = {
  accounts: 'Accounts',
  account: 'Accounts',
  accounting: 'Accounts',
  accountant: 'Accounts',
  accountants: 'Accounts',
  finance: 'Accounts',
  financial: 'Accounts',
  marketing: 'Marketing',
  sales: 'Marketing',
  'business development': 'Marketing',
  hr: 'HR',
  'human resources': 'HR',
  'human resource': 'HR',
  operations: 'Operations',
  operation: 'Operations',
  ops: 'Operations',
  management: 'Management',
  admin: 'Management',
  administration: 'Management',
  it: 'IT',
  'information technology': 'IT',
};

/** The list value a stored department means, or null when it is not clearly one of them. */
export function normalizeDepartment(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return key ? (SYNONYMS[key] ?? null) : null;
}
