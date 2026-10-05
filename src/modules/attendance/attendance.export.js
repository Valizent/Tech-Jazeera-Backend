/**
 * Attendance export — turns a summary (from attendance.service) into a
 * downloadable Excel or PDF buffer. Kept separate from the service so the
 * file-format concern doesn't clutter the business logic.
 *
 * Both formats render the same per-employee summary table so the printed PDF
 * and the spreadsheet always agree.
 */
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

const COLUMNS = ['Present', 'Absent', 'Leave', 'Sick', 'Off'];

/** Excel (.xlsx) — a styled summary sheet. Returns a Buffer. */
export async function buildXlsx(summary) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Al Jazeera ERP';
  const ws = wb.addWorksheet('Attendance Summary');

  ws.mergeCells('A1', 'H1');
  ws.getCell('A1').value = `Attendance Summary ${summary.from} to ${summary.to}`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.addRow([]);

  const header = ws.addRow(['Employee ID', 'Name', ...COLUMNS, 'Total']);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FF' } };
  });

  for (const r of summary.rows) {
    ws.addRow([r.employeeId, r.fullName, r.Present, r.Absent, r.Leave, r.Sick, r.Off, r.total]);
  }

  ws.columns.forEach((col, i) => {
    col.width = i === 1 ? 28 : 12; // wider Name column
  });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** PDF — a printable summary table. Returns a Promise<Buffer>. */
export function buildPdf(summary) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text('Attendance Summary', { align: 'left' });
    doc.fontSize(10).fillColor('#666').text(`${summary.from} to ${summary.to}`);
    doc.moveDown(1);

    // Simple fixed-width table. Columns: ID, Name, then status counts, Total.
    const headers = ['ID', 'Name', ...COLUMNS, 'Total'];
    const widths = [55, 150, 45, 45, 45, 40, 35, 45];
    const startX = doc.page.margins.left;
    let y = doc.y;

    const drawRow = (cells, { bold = false } = {}) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#111');
      let x = startX;
      cells.forEach((cell, i) => {
        doc.text(String(cell), x + 2, y + 4, { width: widths[i] - 4, ellipsis: true });
        x += widths[i];
      });
      y += 18;
      doc.moveTo(startX, y).lineTo(startX + widths.reduce((a, b) => a + b, 0), y).strokeColor('#ddd').stroke();
    };

    drawRow(headers, { bold: true });
    if (summary.rows.length === 0) {
      doc.font('Helvetica').fontSize(10).fillColor('#666').text('No attendance recorded in this range.', startX, y + 6);
    } else {
      for (const r of summary.rows) {
        // Start a new page if we run past the bottom margin.
        if (y > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage();
          y = doc.page.margins.top;
          drawRow(headers, { bold: true });
        }
        drawRow([r.employeeId, r.fullName, r.Present, r.Absent, r.Leave, r.Sick, r.Off, r.total]);
      }
    }

    doc.end();
  });
}
