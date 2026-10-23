// A synthetic two-page PDF, generated in memory so tests never need a committed PDF.
export function twoPagePdf(colors = ['1 0 0', '0 0 1']): string {
  const stream = (color: string) => {
    const content = `${color} rg 0 0 100 100 re f\n`;
    return `<< /Length ${content.length} >>\nstream\n${content}endstream`;
  };
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 100 100] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>', stream(colors[0]),
    '<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 6 0 R >>', stream(colors[1]),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  return pdf + `xref\n0 7\n0000000000 65535 f \n` + offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
