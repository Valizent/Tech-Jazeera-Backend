/**
 * Settlement PDF generation (pdfkit) — mirrors quotation.pdf.js's layout
 * conventions so the two document types feel like one system.
 */
import PDFDocument from 'pdfkit';
import { drawLetterhead, drawSignatoryBlock, LETTERHEAD_HEIGHT } from '../companySettings/letterhead.pdf.js';
import { formatMoney as money, formatShortDate as shortDate } from '../../utils/pdfFormat.js';

const EXIT_REASON_LABELS = {
  Resignation: 'Resignation',
  TerminationByEmployer: 'Termination by employer',
  EndOfContract: 'End of contract',
};

const fraction = (f) => (f === 1 ? 'Full award' : f === 0 ? 'Forfeited (under 2 years)' : `${Math.round(f * 100)}% of the award`);

/** `company`/`logo` are optional — a PDF generated before any company
 *  profile is filled in still works, just without a letterhead/signatory. */
export function buildSettlementPdf(s, company = null, logo = null) {
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

    // Header
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#111').text('END OF SERVICE SETTLEMENT', left, top + 45);
    doc.fontSize(10).font('Helvetica').fillColor('#666');
    doc.text(`Computed  ${shortDate(s.createdAt)}`, left, top + 72);
    doc.font('Helvetica-Bold').fillColor('#111').fontSize(11).text(EXIT_REASON_LABELS[s.exitReason], right - 220, top + 72, { width: 220, align: 'right' });

    // Employee block
    doc.moveTo(left, top + 100).lineTo(right, top + 100).strokeColor('#ddd').stroke();
    doc.fontSize(9).font('Helvetica').fillColor('#666').text('EMPLOYEE', left, top + 110);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text(`${s.employeeName}  (${s.employeeCode})`, left, top + 123);

    const infoRow = (label, value, x, y) => {
      doc.fontSize(9).font('Helvetica').fillColor('#666').text(label, x, y);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#111').text(value, x, y + 12);
    };
    infoRow('JOINING DATE', shortDate(s.joiningDate), left, top + 150);
    infoRow('EXIT DATE', shortDate(s.exitDate), left + 150, top + 150);
    infoRow('SERVICE', `${s.serviceYears} years`, left + 300, top + 150);
    infoRow('MONTHLY WAGE', money(s.monthlyWage), left + 420, top + 150);

    // Breakdown table
    let y = top + 200;
    const row = (label, value, { bold = false, note } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor('#111');
      doc.text(label, left, y, { width: 280 });
      doc.text(value, right - 160, y, { width: 160, align: 'right' });
      if (note) {
        y += 14;
        doc.font('Helvetica').fontSize(8).fillColor('#888').text(note, left, y, { width: 280 });
      }
      y += bold ? 22 : 18;
      doc.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor('#eee').stroke();
    };

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('END OF SERVICE AWARD (ARTICLES 84–85)', left, y);
    y += 16;
    row('Gross award (Article 84)', money(s.eosbGross), { note: 'Half a month’s wage per year for the first 5 years, a full month’s wage per year after.' });
    row('Reduction applied', fraction(s.reductionFactor), { note: s.exitReason === 'Resignation' ? 'Article 85 resignation tiering, by length of service.' : 'Not a resignation — full award, no reduction.' });
    row('Net end-of-service award', money(s.eosbNet), { bold: true });

    y += 10;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('VACATION PAY SETTLEMENT', left, y);
    y += 16;
    row('Unused annual leave', `${s.unusedLeaveDays} day${s.unusedLeaveDays === 1 ? '' : 's'}`);
    row('Leave encashment', money(s.leaveEncashment));

    y += 10;
    row('TOTAL SETTLEMENT', money(s.totalSettlement), { bold: true });

    if (s.notes) {
      y += 14;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('NOTES', left, y);
      doc.font('Helvetica').fontSize(9).fillColor('#111').text(s.notes, left, y + 12, { width: right - left });
      y = doc.y;
    }

    if (company) drawSignatoryBlock(doc, company, left, y + 40, 220);

    doc.end();
  });
}
