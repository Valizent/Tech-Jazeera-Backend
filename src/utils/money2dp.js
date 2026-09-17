import { z } from 'zod';

/**
 * A money amount rejecting anything finer than a cent (originally added
 * 2026-09-15, a real QA-audit-found gap — F4: `min(0.01)` alone accepted a
 * sub-cent amount like 0.015, which downstream atomic `$round` updates then
 * round independently for the stored record vs. the running ledger total —
 * two DIFFERENT numbers computed from the same unrounded input, permanently
 * desyncing the ledger from the cached balance. SAR has no sub-halala
 * denomination to round a payment TO in the first place, so rejecting it
 * here is the honest fix. `Number(n.toFixed(2)) === n` is exact for this
 * check: both sides go through the identical float rounding, so a real 2dp
 * value like 1.10 compares equal to itself, while 0.015 does not.
 */
export const money2dp = (message) =>
  z.coerce
    .number({ error: 'Amount is required.' })
    .min(0.01)
    .refine((n) => Number(n.toFixed(2)) === n, { message });
