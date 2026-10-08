/**
 * settlement.validation.test.js — regression coverage for a bug found while
 * building the mobile app (2026-10-08): the web EOSB form sends '' for an
 * override box left blank, and z.coerce.number() reads '' as 0, so every
 * settlement computed with the boxes blank was saved as SAR 0. A blank box
 * must mean "not overridden"; a real 0 must still be accepted as an override.
 * Pure schema test — no DB needed.
 */
import { createSettlementSchema } from './settlement.validation.js';

const OVERRIDES = ['overrideEosbGross', 'overrideLeaveDays', 'overrideLeaveEncashment'];

function parse(overrides) {
  return createSettlementSchema.safeParse({
    employee: 'a'.repeat(24),
    exitDate: '2026-10-01',
    exitReason: 'Resignation',
    ...overrides,
  });
}

describe('createSettlementSchema overrides', () => {
  it('a blank override box means "not overridden", not 0', () => {
    const result = parse(Object.fromEntries(OVERRIDES.map((k) => [k, ''])));
    expect(result.success).toBe(true);
    for (const k of OVERRIDES) expect(result.data[k]).toBeUndefined();
  });

  it('a whitespace-only box is blank too', () => {
    const result = parse({ overrideEosbGross: '   ' });
    expect(result.success).toBe(true);
    expect(result.data.overrideEosbGross).toBeUndefined();
  });

  it('a real 0 is still a valid override', () => {
    const result = parse({ overrideEosbGross: '0', overrideLeaveDays: 0 });
    expect(result.success).toBe(true);
    expect(result.data.overrideEosbGross).toBe(0);
    expect(result.data.overrideLeaveDays).toBe(0);
  });

  it('a numeric string is coerced and still range-checked', () => {
    expect(parse({ overrideLeaveEncashment: '1500.50' }).data.overrideLeaveEncashment).toBe(1500.5);
    expect(parse({ overrideLeaveDays: '1001' }).success).toBe(false);
    expect(parse({ overrideEosbGross: '-1' }).success).toBe(false);
  });
});
