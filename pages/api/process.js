import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
import fontkit from "@pdf-lib/fontkit";

export const config = { api: { bodyParser: true, sizeLimit: "25mb" } };

// Unicode font served from a public GitHub repo (no local files required)
const FONT_URL = "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

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

    // Load original PDF & embed a Unicode font (fixes ℗/®/™ etc.)
    const pdfDoc = await PDFDocument.load(pdfData);
    pdfDoc.registerFontkit(fontkit);

    const fontRes = await fetch(FONT_URL, { cache: "no-store" });
    if (!fontRes.ok) throw new Error(`Font download failed (${fontRes.status})`);
    const fontBytes = new Uint8Array(await fontRes.arrayBuffer());
    const unicodeFont = await pdfDoc.embedFont(fontBytes, { subset: true });

    const page = pdfDoc.getPages()[0];
    const previewChunk = newText.slice(0, 1800);

    page.drawText(previewChunk, {
      x: 36,
      y: page.getHeight() - 72,
      size: 10,
      lineHeight: 12,
      font: unicodeFont,
      maxWidth: page.getWidth() - 72,
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
