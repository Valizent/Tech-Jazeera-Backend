/** Shared formatting helpers for every pdfkit document generator (Invoice,
 *  Quotation, Settlement, Payroll) — keeps money/date display identical
 *  across every generated PDF, one place to change if it ever needs to. */

export const formatMoney = (n) =>
  `SAR ${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatShortDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
