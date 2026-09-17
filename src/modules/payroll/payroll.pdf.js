/**
 * Payslip PDF generation (pdfkit) — uses the real company letterhead once
 * Company Settings has been filled in (see companySettings/letterhead.pdf.js);
 * falls back to the original minimal header when it hasn't, same as
 * certificate.pdf.js. See docs/P2-M5-notes.md for why this started minimal.
 */
import PDFDocument from 'pdfkit';
import { drawLetterhead, LETTERHEAD_HEIGHT } from '../companySettings/letterhead.pdf.js';
import { formatMoney as money } from '../../utils/pdfFormat.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `company`/`logo` are optional — a payslip generated before any company
 *  profile is filled in still works, just without a letterhead. */
export function buildPayslipPdf({ run, line }, company = null, logo = null) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 45 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const top = company ? LETTERHEAD_HEIGHT : 0;
    if (company) {
      drawLetterhead(doc, company, logo);
    } else {
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#111').text('Al Jazeera', left, 45);
      doc.moveTo(left, 68).lineTo(right, 68).strokeColor('#ddd').stroke();
    }
    doc.fontSize(14).font('Helvetica-Bold').text('PAYSLIP', left, top + 25, { align: 'center', width: right - left });
    doc.font('Helvetica').fontSize(10).fillColor('#666').text(
      `${MONTH_NAMES[run.periodMonth - 1]} ${run.periodYear}`,
      left,
      top + 53,
      { align: 'center', width: right - left }
    );

    doc.fontSize(9).font('Helvetica').fillColor('#666').text('EMPLOYEE', left, top + 85);
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text(`${line.employeeName}  (${line.employeeCode})`, left, top + 98);
    if (line.approvedHours > 0) {
      const overtimeNote = line.overtimeHours > 0 ? ` (incl. ${line.overtimeHours} overtime)` : '';
      doc.fontSize(9).font('Helvetica').fillColor('#666').text(`Approved hours this period: ${line.approvedHours}${overtimeNote}`, left, top + 118);
    }

    let y = top + 145;
    const row = (label, value, { bold = false } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor('#111');
      doc.text(label, left, y, { width: 280 });
      doc.text(value, right - 160, y, { width: 160, align: 'right' });
      y += bold ? 22 : 18;
      doc.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor('#eee').stroke();
    };

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('EARNINGS', left, y);
    y += 16;
    row('Basic salary', money(line.basicSalary));
    row('Housing allowance', money(line.housingAllowance));
    row('Transport allowance', money(line.transportAllowance));
    if (line.otherAllowances) row('Other allowances', money(line.otherAllowances));
    if (line.overtimePay) row(`Overtime (${line.overtimeHours}h @ 1.5×)`, money(line.overtimePay));
    row('Gross pay', money(line.grossPay), { bold: true });

    y += 10;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('DEDUCTIONS', left, y);
    y += 16;
    row('GOSI', money(line.gosiDeduction));
    if (line.sickLeaveDeduction) row(line.sickLeaveNote || 'Sick leave', money(line.sickLeaveDeduction));
    for (const d of line.otherDeductions) row(d.label, money(d.amount));
    row('Total deductions', money(line.totalDeductions), { bold: true });

    y += 10;
    row('NET PAY', money(line.netPay), { bold: true });

    doc.end();
  });
}
