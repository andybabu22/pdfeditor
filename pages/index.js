// pages/api/process.js
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
import fontkit from "@pdf-lib/fontkit";

export const config = { api: { bodyParser: true, sizeLimit: "25mb" } };

// Unicode font fetched at runtime (handles ℗, ™, ®, etc.)
const FONT_URL =
  "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

// -------- Helpers --------
function normalizeWeird(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "") // zero-width + soft hyphen
    .replace(/[⇄⇋•·–—_]+/g, "-")                // unify odd separators
    .replace(/\s{2,}/g, " ")
    .trim();
}
// Phone-like sequences: allow separators and parens; aim for at least ~9 digits total
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

async function embedUnicodeFont(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  const r = await fetch(FONT_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Font download failed (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return pdfDoc.embedFont(bytes, { subset: true });
}

/** Load pdfjs-dist in a way that works across versions/builds.
 *  - Try ESM root first (v4+)
 *  - Fallback to legacy mjs build
 */
async function loadPdfJs() {
  try {
    const mod = await import("pdfjs-dist");
    if (mod?.getDocument) return { getDocument: mod.getDocument };
    if (mod?.default?.getDocument) return { getDocument: mod.default.getDocument };
  } catch (_) {}
  try {
    const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
    if (mod?.getDocument) return { getDocument: mod.getDocument };
    if (mod?.default?.getDocument) return { getDocument: mod.default.getDocument };
  } catch (e) {
    // Final throw with helpful message
    throw new Error(
      `Unable to load pdfjs-dist. Make sure "pdfjs-dist" is in dependencies. Original error: ${e?.message || e}`
    );
  }
  throw new Error("pdfjs-dist loaded but getDocument was not found.");
}

// ------- IN-PLACE (keep layout) -------
async function inplaceReplace(pdfBytes, newNumber) {
  // Copy original pages first
  const srcDoc = await PDFDocument.load(pdfBytes);
  const outDoc = await PDFDocument.create();
  const copied = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
  copied.forEach((p) => outDoc.addPage(p));
  const font = await embedUnicodeFont(outDoc);

  // ✅ Dynamic import (no static 'pdf.js' anywhere)
  const { getDocument } = await loadPdfJs();

  // Parse with pdf.js (no worker in serverless)
  const loadingTask = getDocument({ data: pdfBytes, disableWorker: true });
  const jsDoc = await loadingTask.promise;
  const pageCount = jsDoc.numPages;

  const LINE_Y_TOL = 2.0;
  const WORD_GAP_TOL = 2.0;
  const PAD = 1.5;
  const DRAW_SIZE = 10;

  for (let i = 1; i <= pageCount; i++) {
    const jsPage = await jsDoc.getPage(i);
    const viewport = jsPage.getViewport({ scale: 1.0 });
    const content = await jsPage.getTextContent({ disableCombineTextItems: false });

    // Group items into lines
    const lines = [];
    for (const it of content.items) {
      const [a,b,c,d,e,f] = it.transform;
      const x = e;
      const y = f;
      const width = it.width;
      const height = it.height || Math.hypot(c, d);
      let line = lines.find(L => Math.abs(L.yRef - y) <= LINE_Y_TOL);
      if (!line) { line = { yRef: y, items: [] }; lines.push(line); }
      line.items.push({ str: it.str, x, y, width, height });
    }
    lines.sort((L1, L2) => L2.yRef - L1.yRef);             // top → bottom
    lines.forEach(L => L.items.sort((a,b) => a.x - b.x));   // left → right

    // Build plain text per line + spans mapping
    for (const L of lines) {
      let text = "";
      const spans = []; // { start, end, itemIndex }
      for (let idx = 0; idx < L.items.length; idx++) {
        const it = L.items[idx];
        if (idx > 0) {
          const prev = L.items[idx - 1];
          const gap = it.x - (prev.x + prev.width);
          if (gap > WORD_GAP_TOL) { spans.push({ start: text.length, end: text.length + 1, itemIndex: -1 }); text += " "; }
        }
        const start = text.length;
        text += it.str;
        spans.push({ start, end: text.length, itemIndex: idx });
      }
      L.text = text;
      L.spans = spans;
    }

    const pdfPage = outDoc.getPage(i - 1);
    const pageW = pdfPage.getWidth();
    const pageH = pdfPage.getHeight();
    const scaleX = pageW / viewport.width;
    const scaleY = pageH / viewport.height;

    // Find matches and overlay
    for (const L of lines) {
      const raw = L.text || "";
      if (!raw) continue;

      let m;
      while ((m = PHONE_RE.exec(raw)) !== null) {
        const mStart = m.index;
        const mEnd = m.index + m[0].length;

        // Which items contribute to the match?
        const usedItems = [];
        for (const s of L.spans) {
          if (s.itemIndex < 0) continue;              // inserted space
          if (s.start < mEnd && s.end > mStart) {     // overlap
            usedItems.push(L.items[s.itemIndex]);
          }
        }
        if (!usedItems.length) continue;

        // Bounding box in pdf.js coords
        const minX = Math.min(...usedItems.map(u => u.x)) - PAD;
        const maxX = Math.max(...usedItems.map(u => u.x + u.width)) + PAD;
        const topY = Math.max(...usedItems.map(u => u.y)) + PAD;
        const bottomY = Math.min(...usedItems.map(u => u.y - u.height)) - PAD;

        // Convert to pdf-lib coords
        const pdfX = minX * scaleX;
        const pdfWidth = (maxX - minX) * scaleX;
        const pdfTopFromBottom = pageH - (topY * scaleY);
        const pdfHeight = (topY - bottomY) * scaleY;
        const pdfY = pdfTopFromBottom - pdfHeight;

        // White cover
        pdfPage.drawRectangle({
          x: pdfX,
          y: pdfY,
          width: pdfWidth,
          height: pdfHeight,
          color: { type: "RGB", r: 1, g: 1, b: 1 }
        });

        // Replacement text
        pdfPage.drawText(newNumber, {
          x: pdfX + 0.5,
          y: pdfY + 0.5,
          size: DRAW_SIZE,
          font,
          maxWidth: pdfWidth - 1
        });
      }
    }
  }

  return await outDoc.save();
}

// ------- Overlay (quick preview on page 1) -------
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

// ------- Rebuild (plain text PDF) -------
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

// --------------- API handler ----------------
export default async function handler(req, res) {
  try {
    const { pdfUrl, newNumber, mode = "inplace" } = req.body || {};
    if (!pdfUrl || !newNumber) {
      return res.status(400).json({ error: "Missing pdfUrl or newNumber" });
    }

    const resp = await fetch(pdfUrl);
    if (!resp.ok) throw new Error(`Failed to fetch PDF (${resp.status})`);
    const pdfBytes = Buffer.from(await resp.arrayBuffer());

    let outBytes;
    if (mode === "rebuild") outBytes = await rebuildPdf(pdfBytes, newNumber);
    else if (mode === "overlay") outBytes = await overlayPreview(pdfBytes, newNumber);
    else outBytes = await inplaceReplace(pdfBytes, newNumber); // default keep layout

    const base64 = Buffer.from(outBytes).toString("base64");
    res.status(200).json({
      fileName: (pdfUrl.split("/").pop() || "output.pdf").replace(/[^a-zA-Z0-9._-]/g, "_"),
      preview: mode === "inplace"
        ? "In-place replacement complete (layout preserved)."
        : "Replacement complete.",
      downloadUrl: `data:application/pdf;base64,${base64}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
