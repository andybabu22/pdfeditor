import fetch from "node-fetch";
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";

export const config = { api: { bodyParser: true, sizeLimit: "25mb" } };

export default async function handler(req, res) {
  try {
    const { pdfUrl, newNumber } = req.body;
    const response = await fetch(pdfUrl);
    const buffer = await response.arrayBuffer();
    const pdfData = Buffer.from(buffer);
    const text = (await pdfParse(pdfData)).text;

    const phoneRegex = /(\+?\d[\d\s•\-().⇄⇋–_]{7,}\d)/g;
    const normalize = txt =>
      txt.replace(/[⇄⇋•–_]+/g, "-").replace(/\s{2,}/g, " ");
    const newText = normalize(text).replace(phoneRegex, newNumber);

    const pdfDoc = await PDFDocument.load(pdfData);
    const firstPage = pdfDoc.getPages()[0];
    firstPage.drawText(newText.slice(0, 1000));

    const outPdf = await pdfDoc.save();
    const base64 = Buffer.from(outPdf).toString("base64");

    res.status(200).json({
      fileName: pdfUrl.split("/").pop(),
      preview: newText.substring(0, 500),
      downloadUrl: `data:application/pdf;base64,${base64}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
