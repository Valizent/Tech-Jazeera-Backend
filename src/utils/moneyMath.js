/** Round to 2 decimal places (money). */
export const roundMoney = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Compute quotation/invoice totals from line items — the one authoritative
 * formula. SECURITY / CORRECTNESS: totals are ALWAYS computed here from the
 * line items, never taken from the request — a client can send whatever it
 * likes; the stored subtotal/discount/tax/grand total are what this
 * function calculates.
 *   gross    = quantity × unitPrice
 *   discount = gross × discount%          (per line)
 *   net      = gross − discount
 *   tax      = net × taxRate%             (per line, on the discounted amount)
 *   grand    = subtotal − discountTotal + taxTotal
 *
 * Shared by invoice.service.js and quotation.service.js — sharing this pure
 * function creates no live coupling between an Invoice and its source
 * Quotation (each caller passes its own line items and the result is
 * stored immediately, not recomputed later); it only guarantees both use
 * the identical formula, which is what "authoritative money math" means.
 */
export function computeTotals(lineItems) {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  for (const li of lineItems) {
    const gross = li.quantity * li.unitPrice;
    const discount = gross * ((li.discount ?? 0) / 100);
    const net = gross - discount;
    const tax = net * ((li.taxRate ?? 0) / 100);
    subtotal += gross;
    discountTotal += discount;
    taxTotal += tax;
  }
  return {
    subtotal: roundMoney(subtotal),
    discountTotal: roundMoney(discountTotal),
    taxTotal: roundMoney(taxTotal),
    grandTotal: roundMoney(subtotal - discountTotal + taxTotal),
  };
}

/** Amount one line item contributes to the grand total (net + its tax) —
 *  the same per-line math computeTotals sums, used where a PDF/view needs
 *  just one line's own contribution rather than the whole document's
 *  totals. */
export function lineAmount(li) {
  const gross = li.quantity * li.unitPrice;
  const net = gross - gross * ((li.discount ?? 0) / 100);
  return net + net * ((li.taxRate ?? 0) / 100);
}
