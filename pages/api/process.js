// pages/api/process.js
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
import fontkit from "@pdf-lib/fontkit";

export const config = { api: { bodyParser: true, sizeLimit: "25mb" } };

// Unicode font fetched at runtime (handles ℗, ™, ®, etc.)
const FONT_URL =
  "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

function normalizeWeird(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "") // zero-width + soft hyphen
    .replace(/[⇄⇋•·–—_]+/g, "-")                // unify odd separators
    .replace(/\s{2,}/g, " ")
    .trim();
}
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

async function embedUnicodeFont(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  const r = await fetch(FONT_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Font download failed (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return pdfDoc.embedFont(bytes, { subset: true });
}

// Overlay (fast preview on page 1)
async function overlayPreview(pdfBytes, newNumber) {
  const text = (await pdfParse(pdfBytes)).text || "";
  const replaced = normalizeWeird(text).replace(PHONE_RE, newNumber);

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await embedUnicodeFont(pdfDoc);
  const page = pdfDoc.getPages()[0];
  const chunk = replaced.slice(0, 1800);
  page.drawText(chunk, {
    x: 36,
    y: page.getHeight() - 72,
    size: 10,
    lineHeight: 12,
    font,
    maxWidth: page.getWidth() - 72
  });
  return await pdfDoc.save();
}

// Rebuild (plain text PDF)
async function rebuildPdf(pdfBytes, newNumber) {
  const out = await PDFDocument.create();
  const font = await embedUnicodeFont(out);

  const text = (await pdfParse(pdfBytes)).text || "";
  const replaced = normalizeWeird(text).replace(PHONE_RE, newNumber);

  const page = out.addPage([612, 792]); // Letter
  page.drawText(replaced.slice(0, 8000), {
    x: 36, y: 792 - 72, size: 10, lineHeight: 12, font, maxWidth: 612 - 72
  });
  return await out.save();
}

export default async function handler(req, res) {
  try {
    const { pdfUrl, newNumber, mode = "rebuild" } = req.body || {};
    if (!pdfUrl || !newNumber) {
      return res.status(400).json({ error: "Missing pdfUrl or newNumber" });
    }

    const resp = await fetch(pdfUrl);
    if (!resp.ok) throw new Error(`Failed to fetch PDF (${resp.status})`);
    const pdfBytes = Buffer.from(await resp.arrayBuffer());

    let outBytes;
    if (mode === "overlay") outBytes = await overlayPreview(pdfBytes, newNumber);
    else outBytes = await rebuildPdf(pdfBytes, newNumber);

    const base64 = Buffer.from(outBytes).toString("base64");
    res.status(200).json({
      fileName: (pdfUrl.split("/").pop() || "output.pdf").replace(/[^a-zA-Z0-9._-]/g, "_"),
      preview: mode === "overlay" ? "Overlay preview created." : "Rebuilt PDF created.",
      downloadUrl: `data:application/pdf;base64,${base64}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
