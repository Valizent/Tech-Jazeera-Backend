/**
 * Pure payment-allocation math, shared by the client payment ledger
 * (clientPayment.service.js) and the subcontractor one
 * (subcontractorPayment.service.js). No database, no domain knowledge: given
 * the invoiced items of one counterparty and its Approved payments, decide how
 * much of each item has been paid. Recomputed live on every call; the only
 * thing stored is what the recorder chose (a payment's `allocations`).
 *
 * Two kinds of payment (2026-10-13, the user's own rule):
 *  - one whose recorder PICKED invoices, in order (`allocated: true`): its cash
 *    (plus any unallocated credit already on the account) fills those invoices
 *    in that order, the last one possibly only part-paid. What is left over is
 *    unallocated credit, added to the next payment.
 *  - an older one with no pick (`allocated` false): applied oldest invoice
 *    first, exactly as before.
 * Older payments are applied first, then the picked ones, oldest first.
 *
 * An "invoice" is every invoiced entry sharing one invoice number (one real
 * document covers several workers' months); an entry with no number is its own.
 */
import ApiError from '../../utils/ApiError.js';

const money = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The identity of the invoice an item belongs to. */
export function invoiceKeyOf(item) {
  const number = item.invoiceNumber == null ? '' : String(item.invoiceNumber).trim();
  return number ? `no:${number.toLowerCase()}` : `entry:${item.entryId}`;
}

/**
 * @param {Array} invoicedItems  each `{ ...caller fields, revenue, invoiceSentAt, invoiceNumber?, entryId }`
 * @param {Array} approvedPayments  each `{ _id, amount, paymentDate, paymentReference, allocated, allocations }`
 * @returns {{ perEntry: Array, creditBalance: number }}
 *   perEntry keeps every existing field (`amountAllocated`, `balanceDue`,
 *   `fullyPaid`, `payments[{ paymentId, amount, paymentDate, paymentReference,
 *   runningBalance }]`) and gains `invoiceKey`.
 */
export function allocatePayments(invoicedItems, approvedPayments) {
  const states = [...invoicedItems]
    .sort((a, b) => new Date(a.invoiceSentAt) - new Date(b.invoiceSentAt))
    .map((item) => ({ item, key: invoiceKeyOf(item), needed: item.revenue, running: item.revenue, payments: [] }));
  const byKey = new Map();
  for (const st of states) {
    if (!byKey.has(st.key)) byKey.set(st.key, []);
    byKey.get(st.key).push(st);
  }

  let credit = 0;
  const apply = (st, take, payment) => {
    st.needed = money(st.needed - take);
    st.running = money(st.running - take);
    st.payments.push({
      paymentId: payment._id,
      amount: take,
      paymentDate: payment.paymentDate,
      paymentReference: payment.paymentReference,
      runningBalance: st.running,
    });
  };
  const byDate = (a, b) => new Date(a.paymentDate) - new Date(b.paymentDate) || String(a._id).localeCompare(String(b._id));

  // Older payments: oldest invoice first.
  for (const payment of approvedPayments.filter((p) => !p.allocated).sort(byDate)) {
    credit = money(credit + payment.amount);
    for (const st of states) {
      if (credit <= 0) break;
      if (st.needed <= 0) continue;
      const take = money(Math.min(credit, st.needed));
      apply(st, take, payment);
      credit = money(credit - take);
    }
  }
  // Picked payments: in the order the recorder chose.
  for (const payment of approvedPayments.filter((p) => p.allocated).sort(byDate)) {
    credit = money(credit + payment.amount);
    for (const allocation of payment.allocations ?? []) {
      let want = money(Math.min(allocation.amount, credit));
      for (const st of byKey.get(allocation.invoiceKey) ?? []) {
        if (want <= 0) break;
        if (st.needed <= 0) continue;
        const take = money(Math.min(want, st.needed));
        apply(st, take, payment);
        want = money(want - take);
        credit = money(credit - take);
      }
    }
  }

  const perEntry = states.map((st) => {
    const balanceDue = money(st.needed);
    return {
      ...st.item,
      invoiceKey: st.key,
      amountAllocated: money(st.item.revenue - st.needed),
      balanceDue,
      fullyPaid: balanceDue <= 0,
      payments: st.payments,
    };
  });
  return { perEntry, creditBalance: money(credit) };
}

/** Outstanding invoices: one row per invoice with something left to pay. */
export function outstandingInvoices(perEntry) {
  const groups = new Map();
  for (const e of perEntry) {
    if (e.balanceDue <= 0) continue;
    const g = groups.get(e.invoiceKey) ?? { invoiceKey: e.invoiceKey, invoiceNumber: e.invoiceNumber ?? null, balanceDue: 0 };
    g.balanceDue = money(g.balanceDue + e.balanceDue);
    groups.set(e.invoiceKey, g);
  }
  return [...groups.values()];
}

/**
 * Turns "this much money, onto these invoices in this order" into the stored
 * allocations. The money is the amount received plus the unallocated credit
 * already on the account; each picked invoice takes what it still owes, in
 * order, until the money runs out; anything left stays credit. A key that is
 * not an outstanding invoice of this account, or picked twice, is refused.
 */
export function planAllocations({ perEntry, creditBalance, amount, invoiceKeys }) {
  const outstanding = new Map(outstandingInvoices(perEntry).map((g) => [g.invoiceKey, g]));
  const seen = new Set();
  let available = money(amount + creditBalance);
  const allocations = [];
  for (const key of invoiceKeys) {
    if (seen.has(key)) throw new ApiError(400, 'Pick each invoice only once.');
    seen.add(key);
    const invoice = outstanding.get(key);
    if (!invoice) throw new ApiError(400, 'One of the picked invoices is not outstanding (it may have just been paid). Refresh and pick again.');
    const take = money(Math.min(available, invoice.balanceDue));
    if (take <= 0) continue;
    allocations.push({ invoiceKey: key, invoiceNumber: invoice.invoiceNumber, amount: take });
    available = money(available - take);
  }
  return { allocations, leftover: available };
}
