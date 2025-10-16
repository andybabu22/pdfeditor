import { PDFDocument, StandardFonts } from "pdf-lib";
import pdfParse from "pdf-parse";

export const config = { api: { bodyParser: true, sizeLimit: "25mb" } };

export default async function handler(req, res) {
  try {
    const { pdfUrl, newNumber } = req.body || {};
    if (!pdfUrl || !newNumber) return res.status(400).json({ error: "Missing pdfUrl or newNumber" });

    const response = await fetch(pdfUrl);
    if (!response.ok) throw new Error(`Failed to fetch PDF (${response.status})`);
    const arrayBuf = await response.arrayBuffer();
    const pdfData = Buffer.from(arrayBuf);

    const text = (await pdfParse(pdfData)).text || "";

    // robust phone-like sequence detection (handles ⇄, ⇋, •, –, spaces, parens, dashes)
    const phoneRegex = /(\+?\d[\d\s•\-().⇄⇋–_]{7,}\d)/g;
    const normalize = (txt) =>
      txt.replace(/[⇄⇋•–_]+/g, "-").replace(/\s{2,}/g, " ");

    const newText = normalize(text).replace(phoneRegex, newNumber);

    // overlay replaced text chunk onto first page (simple preview/output)
    const pdfDoc = await PDFDocument.load(pdfData);
    const firstPage = pdfDoc.getPages()[0];
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const previewChunk = newText.slice(0, 1800);
    firstPage.drawText(previewChunk, {
      x: 36,
      y: firstPage.getHeight() - 72,
      size: 10,
      lineHeight: 12,
      font,
      maxWidth: firstPage.getWidth() - 72,
    });

    const outPdf = await pdfDoc.save();
    const base64 = Buffer.from(outPdf).toString("base64");

    res.status(200).json({
      fileName: pdfUrl.split("/").pop(),
      preview: newText.substring(0, 500),
      downloadUrl: `data:application/pdf;base64,${base64}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
