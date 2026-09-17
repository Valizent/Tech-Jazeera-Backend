/**
 * Invoice PDF generation (pdfkit) — reuses quotation.pdf.js's exact layout
 * conventions, plus a payments/balance section quotations don't need.
 */
import PDFDocument from 'pdfkit';
import { drawLetterhead, LETTERHEAD_HEIGHT } from '../companySettings/letterhead.pdf.js';
import { formatMoney as money, formatShortDate as shortDate } from '../../utils/pdfFormat.js';
import { lineAmount } from '../../utils/moneyMath.js';

/** `company`/`logo` are optional — a PDF generated before any company
 *  profile is filled in still works, just without a letterhead. */
export function buildInvoicePdf(inv, company = null, logo = null) {
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

    const cols = [
      { key: 'type', label: 'Type', w: 55, align: 'left' },
      { key: 'description', label: 'Description', w: 165, align: 'left' },
      { key: 'quantity', label: 'Qty', w: 40, align: 'right' },
      { key: 'unitPrice', label: 'Unit', w: 70, align: 'right' },
      { key: 'discount', label: 'Disc%', w: 45, align: 'right' },
      { key: 'taxRate', label: 'Tax%', w: 40, align: 'right' },
      { key: 'amount', label: 'Amount', w: 90, align: 'right' },
    ];
    let y = top + 195;
    const drawRow = (cells, { bold = false } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#111');
      let x = left;
      for (const col of cols) {
        doc.text(String(cells[col.key] ?? ''), x + 2, y + 5, { width: col.w - 4, align: col.align, ellipsis: true });
        x += col.w;
      }
      y += 20;
      doc.moveTo(left, y).lineTo(right, y).strokeColor('#eee').stroke();
    };

    drawRow(Object.fromEntries(cols.map((c) => [c.key, c.label])), { bold: true });
    for (const li of inv.lineItems) {
      if (y > doc.page.height - 220) {
        doc.addPage();
        y = 60;
        drawRow(Object.fromEntries(cols.map((c) => [c.key, c.label])), { bold: true });
      }
      drawRow({
        type: li.type,
        description: li.description,
        quantity: li.quantity,
        unitPrice: money(li.unitPrice).replace('SAR ', ''),
        discount: li.discount ?? 0,
        taxRate: li.taxRate ?? 0,
        amount: money(lineAmount(li)).replace('SAR ', ''),
      });
    }

    y += 10;
    const totalRow = (label, value, { bold = false } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#111');
      doc.text(label, right - 240, y, { width: 130, align: 'right' });
      doc.text(money(value), right - 100, y, { width: 100, align: 'right' });
      y += bold ? 22 : 16;
    };
    totalRow('Subtotal', inv.subtotal);
    totalRow('Discount', -inv.discountTotal);
    totalRow('VAT / Tax', inv.taxTotal);
    doc.moveTo(right - 240, y).lineTo(right, y).strokeColor('#ccc').stroke();
    y += 6;
    totalRow('Grand Total', inv.grandTotal, { bold: true });
    totalRow('Paid', inv.amountPaid);
    totalRow('Balance Due', inv.balanceDue, { bold: true });

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
