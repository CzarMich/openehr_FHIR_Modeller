export function sourcePdf(padding = 0) {
    // Minimal independent PDF fixture, with a text page and standard font.
    const stream = "BT /F1 12 Tf 20 100 Td (Renal publication evidence) Tj ET";
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n" + (padding ? "%" + "x".repeat(padding) + "\n" : ""),
        offsets = [0];
    objects.forEach((object, i) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf +=
        `xref\n0 6\n0000000000 65535 f \n` +
        offsets
            .slice(1)
            .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
            .join("") +
        `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
}
