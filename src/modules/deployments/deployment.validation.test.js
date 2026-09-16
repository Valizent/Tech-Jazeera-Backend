/**
 * deployment.validation.test.js — regression coverage for F7 (docs/QA-
 * AUDIT-2026-09-15-notes.md): `z.coerce.boolean()` coerces via plain JS
 * truthiness of the RAW input before any type check, so the literal JSON
 * string "false" (a reasonable thing for a raw HTTP client to send) became
 * `true` — silently exiting an employee who shouldn't have been. Replaced
 * with a strict preprocessor that only ever maps a real boolean or the
 * exact strings "true"/"false", leaving anything else for z.boolean() to
 * reject outright rather than coerce. Pure schema test — no DB needed.
 */
import { demobiliseDeploymentSchema } from './deployment.validation.js';

function parse(exitOutcome) {
  return demobiliseDeploymentSchema.safeParse({
    releaseDate: '2027-01-01',
    reason: 'Other',
    releaseNote: 'test',
    exitOutcome,
  });
}

describe('demobiliseDeploymentSchema exitOutcome (F7)', () => {
  it('the string "false" parses to boolean false, not true', () => {
    const result = parse('false');
    expect(result.success).toBe(true);
    expect(result.data.exitOutcome).toBe(false);
  });

  it('the string "true" parses to boolean true', () => {
    const result = parse('true');
    expect(result.success).toBe(true);
    expect(result.data.exitOutcome).toBe(true);
  });

  it('a real boolean false is left unchanged', () => {
    const result = parse(false);
    expect(result.success).toBe(true);
    expect(result.data.exitOutcome).toBe(false);
  });

  it('an unrecognized string like "yes" is rejected, not silently coerced', () => {
    const result = parse('yes');
    expect(result.success).toBe(false);
  });

  it('omitting exitOutcome is valid (optional)', () => {
    const result = parse(undefined);
    expect(result.success).toBe(true);
    expect(result.data.exitOutcome).toBeUndefined();
  });
});
