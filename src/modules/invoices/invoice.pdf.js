/**
 * Invoice PDF generation (pdfkit) — reuses quotation.pdf.js's exact layout
 * conventions, plus a payments/balance section quotations don't need.
 *
 * ZATCA Phase 1 QR code (2026-09-24): drawn top-right, only once the
 * company's own VAT number is on file — never a fabricated one. Phase 2
 * (real-time clearance via ZATCA's own API) is deliberately NOT attempted
 * here; it needs a government-issued certificate this app has no way to
 * invent. See zatcaQr.js's own doc comment for the field spec.
 */
import PDFDocument from 'pdfkit';
import { drawLetterhead, LETTERHEAD_HEIGHT } from '../companySettings/letterhead.pdf.js';
import { formatMoney as money, formatShortDate as shortDate } from '../../utils/pdfFormat.js';
import { lineAmount } from '../../utils/moneyMath.js';
import { LINE_ITEM_COLUMNS, drawLineItemRow, drawTotalRow } from '../../utils/pdfLineItemTable.js';
import { buildZatcaQrPng } from '../../utils/zatcaQr.js';

/** `company`/`logo` are optional — a PDF generated before any company
 *  profile is filled in still works, just without a letterhead. */
export async function buildInvoicePdf(inv, company = null, logo = null) {
  // Generated BEFORE the pdfkit stream starts — pdfkit's own doc.image()
  // needs a buffer in hand synchronously; awaiting inside the Promise
  // executor below would work too, but doing it up front keeps this
  // function's only async step in one obvious place.
  let qrPng = null;
  if (company?.vatNumber) {
    qrPng = await buildZatcaQrPng({
      sellerName: company.companyName || 'Company name not set',
      vatNumber: company.vatNumber,
      timestamp: inv.date,
      invoiceTotal: inv.grandTotal,
      vatTotal: inv.taxTotal,
    });
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 45 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const top = company ? LETTERHEAD_HEIGHT : 0;
    if (company) drawLetterhead(doc, company, logo);

    if (qrPng) {
      const qrSize = 62;
      doc.image(qrPng, right - qrSize, top, { width: qrSize, height: qrSize });
    }

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#111').text('INVOICE', left, top + 45);
    doc.fontSize(10).font('Helvetica').fillColor('#666');
    doc.text(`No.  ${inv.invoiceNumber}`, left, top + 72);
    doc.text(`Date  ${shortDate(inv.date)}`, left, top + 86);
    if (inv.dueDate) doc.text(`Due  ${shortDate(inv.dueDate)}`, left, top + 100);
    doc.text(`From quotation  ${inv.quotationNumber}`, left, top + 114);
    doc.font('Helvetica-Bold').fillColor('#111').fontSize(11).text(inv.status.toUpperCase(), right - 120, top + 72, { width: 120, align: 'right' });

    doc.moveTo(left, top + 136).lineTo(right, top + 136).strokeColor('#ddd').stroke();
    doc.fontSize(9).font('Helvetica').fillColor('#666').text('BILL TO', left, top + 146);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text(inv.clientName, left, top + 159);
    if (inv.clientVatNumber) {
      doc.fontSize(9).font('Helvetica').fillColor('#666').text(`VAT ${inv.clientVatNumber}`, left, doc.y + 2);
    }

    const headerCells = Object.fromEntries(LINE_ITEM_COLUMNS.map((c) => [c.key, c.label]));
    let y = top + 195;
    y = drawLineItemRow(doc, { left, right, y, cells: headerCells, bold: true });
    for (const li of inv.lineItems) {
      if (y > doc.page.height - 220) {
        doc.addPage();
        y = 60;
        y = drawLineItemRow(doc, { left, right, y, cells: headerCells, bold: true });
      }
      y = drawLineItemRow(doc, {
        left,
        right,
        y,
        cells: {
          type: li.type,
          description: li.description,
          quantity: li.quantity,
          unitPrice: money(li.unitPrice).replace('SAR ', ''),
          discount: li.discount ?? 0,
          taxRate: li.taxRate ?? 0,
          amount: money(lineAmount(li)).replace('SAR ', ''),
        },
      });
    }

    y += 10;
    y = drawTotalRow(doc, { right, y, label: 'Subtotal', value: inv.subtotal });
    y = drawTotalRow(doc, { right, y, label: 'Discount', value: -inv.discountTotal });
    y = drawTotalRow(doc, { right, y, label: 'VAT / Tax', value: inv.taxTotal });
    doc.moveTo(right - 240, y).lineTo(right, y).strokeColor('#ccc').stroke();
    y += 6;
    y = drawTotalRow(doc, { right, y, label: 'Grand Total', value: inv.grandTotal, bold: true });
    if (inv.creditedTotal > 0) {
      y = drawTotalRow(doc, { right, y, label: 'Credited', value: -inv.creditedTotal });
    }
    y = drawTotalRow(doc, { right, y, label: 'Paid', value: inv.amountPaid });
    y = drawTotalRow(doc, { right, y, label: 'Balance Due', value: inv.balanceDue, bold: true });

    if (inv.balanceDue > 0 && company?.bankName && company?.bankIban) {
      y += 10;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('PAYMENT INSTRUCTIONS', left, y);
      y += 14;
      doc.font('Helvetica').fontSize(9).fillColor('#111').text(`${company.bankName}  ·  IBAN ${company.bankIban}`, left, y);
      y += 14;
    }

    if (inv.payments.length > 0) {
      y += 14;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('PAYMENTS', left, y);
      y += 14;
      for (const p of inv.payments) {
        doc.font('Helvetica').fontSize(9).fillColor('#111').text(
          `${shortDate(p.date)} — ${money(p.amount)}${p.method ? ` (${p.method})` : ''}${p.reference ? ` · ${p.reference}` : ''}`,
          left,
          y
        );
        y += 14;
      }
    }

    if (inv.notes) {
      y += 10;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('NOTES', left, y);
      doc.font('Helvetica').fontSize(9).fillColor('#111').text(inv.notes, left, y + 12, { width: right - left });
    }

    doc.end();
  });
}
