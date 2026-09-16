/**
 * mobilisation.dateOverlap.test.js — regression coverage for the 2026-09-16
 * checkout-date-aware overlap fix (the user's own report: entering backlog
 * data kept getting blocked by a later, already-recorded placement, because
 * assertNoDateOverlap always treated a new mobilisation as OPEN-ENDED —
 * `[mobilisationDate, ∞)` — ignoring whatever checkout date was typed. See
 * mobilisation.service.js's assertNoDateOverlap doc comment for the full
 * interval-overlap reasoning this tests against.
 */
import mongoose from 'mongoose';
import Employee from '../employees/employee.model.js';
import Client from '../clients/client.model.js';
import Mobilisation from './mobilisation.model.js';
import Deployment from '../deployments/deployment.model.js';
import { createMobilisation, updateMobilisation } from './mobilisation.service.js';

function actor() {
  return { userId: new mongoose.Types.ObjectId().toString(), role: 'Admin', ip: '127.0.0.1' };
}

async function makeEmployee() {
  return Employee.create({
    employeeId: `EMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fullName: 'Overlap Test Worker',
    type: 'Own',
    designation: 'Tester',
    joiningDate: new Date('2020-01-01'),
  });
}

async function makeClient(name) {
  return Client.create({ companyName: name });
}

/** Directly records a real historical placement, bypassing the whole
 *  create-approve-demobilise pipeline — deploymentPeriodsFor (the function
 *  under test, indirectly) only ever reads startDate/endDate/clientName off
 *  real Deployment documents, so this is a faithful, minimal fixture for it. */
async function makeDeployment({ employee, client, startDate, endDate }) {
  const dummyMobilisation = await Mobilisation.create({
    serialNumber: `MOB-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    workerType: 'Employee',
    worker: employee._id,
    workerName: employee.fullName,
    jobTitle: 'Labour',
    client: client._id,
    clientName: client.companyName,
    mobilisationDate: startDate,
    status: 'Completed',
    createdBy: new mongoose.Types.ObjectId(),
    coordinators: [{ user: new mongoose.Types.ObjectId(), isPrimary: true, confirmed: true }],
  });
  return Deployment.create({
    mobilisation: dummyMobilisation._id,
    workerType: 'Employee',
    worker: employee._id,
    workerName: employee.fullName,
    client: client._id,
    clientName: client.companyName,
    startDate,
    endDate,
    status: endDate ? 'Ended' : 'Active',
    enteredBy: new mongoose.Types.ObjectId(),
  });
}

function baseMobilisationInput({ employeeId, clientId, mobilisationDate, checkoutDate }) {
  return {
    workerType: 'Employee',
    worker: employeeId,
    jobTitle: 'Labour',
    client: clientId,
    clientRate: 30,
    mobilisationDate,
    checkoutDate,
  };
}

describe('assertNoDateOverlap — checkout-date-aware (2026-09-16 backlog-entry fix)', () => {
  it('reproduces the user\'s exact report: a backlog entry with NO checkout date is blocked by a later real placement', async () => {
    const employee = await makeEmployee();
    const conflictClient = await makeClient('UNITED ARK CONTRACTING');
    const newClient = await makeClient('Backlog Test Client A');
    await makeDeployment({
      employee,
      client: conflictClient,
      startDate: new Date('2026-09-12'),
      endDate: new Date('2026-09-12'),
    });

    await expect(
      createMobilisation(
        baseMobilisationInput({
          employeeId: employee._id.toString(),
          clientId: newClient._id.toString(),
          mobilisationDate: new Date('2026-04-01'),
          // No checkoutDate — same as the report's own repro.
        }),
        actor()
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('FIX: the same backlog entry succeeds once a real checkout date is given that ends before the later placement starts', async () => {
    const employee = await makeEmployee();
    const conflictClient = await makeClient('UNITED ARK CONTRACTING');
    const newClient = await makeClient('Backlog Test Client B');
    await makeDeployment({
      employee,
      client: conflictClient,
      startDate: new Date('2026-09-12'),
      endDate: new Date('2026-09-12'),
    });

    const created = await createMobilisation(
      baseMobilisationInput({
        employeeId: employee._id.toString(),
        clientId: newClient._id.toString(),
        mobilisationDate: new Date('2026-04-01'),
        checkoutDate: new Date('2026-09-10'), // ends before the conflicting period starts
      }),
      actor()
    );
    expect(created.checkoutDate).toBeTruthy();
  });

  it('a checkout date that genuinely overlaps a real placement is still blocked', async () => {
    const employee = await makeEmployee();
    const conflictClient = await makeClient('UNITED ARK CONTRACTING');
    const newClient = await makeClient('Backlog Test Client C');
    await makeDeployment({
      employee,
      client: conflictClient,
      startDate: new Date('2026-09-12'),
      endDate: new Date('2026-09-20'),
    });

    await expect(
      createMobilisation(
        baseMobilisationInput({
          employeeId: employee._id.toString(),
          clientId: newClient._id.toString(),
          mobilisationDate: new Date('2026-04-01'),
          checkoutDate: new Date('2026-09-15'), // lands inside the real 12th-20th period
        }),
        actor()
      )
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('same-day handoff still allowed: checkout date exactly equal to the next period\'s start date', async () => {
    const employee = await makeEmployee();
    const conflictClient = await makeClient('UNITED ARK CONTRACTING');
    const newClient = await makeClient('Backlog Test Client D');
    await makeDeployment({
      employee,
      client: conflictClient,
      startDate: new Date('2026-09-12'),
      endDate: new Date('2026-09-20'),
    });

    const created = await createMobilisation(
      baseMobilisationInput({
        employeeId: employee._id.toString(),
        clientId: newClient._id.toString(),
        mobilisationDate: new Date('2026-04-01'),
        checkoutDate: new Date('2026-09-12'), // ends exactly when the other one starts
      }),
      actor()
    );
    expect(created).toBeTruthy();
  });

  it('CLEAR / reset: editing an existing Draft back to no checkout date re-runs the check and still blocks a real conflict', async () => {
    const employee = await makeEmployee();
    const conflictClient = await makeClient('UNITED ARK CONTRACTING');
    const newClient = await makeClient('Backlog Test Client E');
    await makeDeployment({
      employee,
      client: conflictClient,
      startDate: new Date('2026-09-12'),
      endDate: new Date('2026-09-20'),
    });

    // Created with a checkout date that legitimately avoids the conflict.
    const created = await createMobilisation(
      baseMobilisationInput({
        employeeId: employee._id.toString(),
        clientId: newClient._id.toString(),
        mobilisationDate: new Date('2026-04-01'),
        checkoutDate: new Date('2026-09-01'),
      }),
      actor()
    );

    // Clearing the checkout date reverts to "still ongoing" — which DOES
    // conflict with the later real placement — so the re-check must catch it.
    await expect(updateMobilisation(created._id.toString(), { checkoutDate: '' }, actor())).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('no checkout date and no later real placement — plain open-ended create still works (baseline unaffected)', async () => {
    const employee = await makeEmployee();
    const newClient = await makeClient('Backlog Test Client F');
    const created = await createMobilisation(
      baseMobilisationInput({
        employeeId: employee._id.toString(),
        clientId: newClient._id.toString(),
        mobilisationDate: new Date('2026-04-01'),
      }),
      actor()
    );
    expect(created).toBeTruthy();
  });
});
