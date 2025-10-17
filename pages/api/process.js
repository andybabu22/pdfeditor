// pages/api/process.js
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
import fontkit from "@pdf-lib/fontkit";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

export const config = { api: { bodyParser: true, sizeLimit: "25mb" } };

// Unicode font fetched at runtime (no local files required)
const FONT_URL =
  "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

// Basic normalization helpers reused by rebuild/overlay; detection for inplace is per-page.
function normalizeWeird(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "") // zero-width + soft hyphen
    .replace(/[⇄⇋•·–—_]+/g, "-")                // unify odd separators
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Our phone pattern after normalization: digits + separators, at least ~9 digits total
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

async function embedUnicodeFont(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  const r = await fetch(FONT_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Font download failed (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return pdfDoc.embedFont(bytes, { subset: true });
}

/** -------- IN-PLACE MODE (keep layout) ----------
 * Strategy:
 * 1) Copy all pages from source PDF to outDoc (so layout stays).
 * 2) Use pdfjs-dist to read text items + positions.
 * 3) Group items by line (y within tolerance). Build a line string & track which items contribute.
 * 4) Run regex on each line string; for each match, compute a bounding box from the items that overlap the match.
 * 5) On outDoc, draw a white rectangle over the bbox and draw replacement number at that position.
 */
async function inplaceReplace(pdfBytes, newNumber) {
  const srcDoc = await PDFDocument.load(pdfBytes);
  const outDoc = await PDFDocument.create();
  const copied = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
  copied.forEach(p => outDoc.addPage(p));
  const font = await embedUnicodeFont(outDoc);

  // Parse with pdfjs-dist (no worker in serverless)
  const loadingTask = pdfjsLib.getDocument({ data: pdfBytes, disableWorker: true });
  const jsDoc = await loadingTask.promise;
  const pageCount = jsDoc.numPages;

  const LINE_Y_TOL = 2.0;       // pixels; items within this y-distance are same line
  const WORD_GAP_TOL = 2.0;     // pixels; if gap between items > tol, insert a space
  const PAD = 1.5;              // white cover padding around bbox
  const DRAW_SIZE = 10;         // replacement text size (simple heuristic)

  for (let i = 1; i <= pageCount; i++) {
    const jsPage = await jsDoc.getPage(i);
    const viewport = jsPage.getViewport({ scale: 1.0 });
    const content = await jsPage.getTextContent({ disableCombineTextItems: false });

    // Build lines
    const lines = []; // [{ yRef, items: [{str,x,y,width,height}], text, parts: [{start,end,itemIndex}]}]
    for (const it of content.items) {
      const [a,b,c,d,e,f] = it.transform; // matrix
      const x = e;
      const y = f;
      const width = it.width;
      const height = it.height || Math.hypot(c, d);
      // Assign to a line by y
      let line = lines.find(L => Math.abs(L.yRef - y) <= LINE_Y_TOL);
      if (!line) { line = { yRef: y, items: [] }; lines.push(line); }
      line.items.push({ str: it.str, x, y, width, height });
    }

    // Sort lines top->bottom (pdf.js y grows up; we want visual top first)
    lines.sort((L1, L2) => L2.yRef - L1.yRef);
    // Sort items left->right per line
    lines.forEach(L => L.items.sort((a,b) => a.x - b.x));

    // Build text per line with basic spacing + mapping
    for (const L of lines) {
      let text = "";
      const spans = []; // maps char range -> item index
      for (let idx = 0; idx < L.items.length; idx++) {
        const it = L.items[idx];
        if (idx > 0) {
          const prev = L.items[idx - 1];
          const gap = it.x - (prev.x + prev.width);
          if (gap > WORD_GAP_TOL) {
            spans.push({ start: text.length, end: text.length + 1, itemIndex: -1 });
            text += " ";
          }
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

      // Normalize just for matching (but don't use normalized text for bboxes)
      const matchText = normalizeWeird(raw);
      // Build a crude mapping back to raw indices (same length if we only trim & squeeze separators)
      // We'll just run the regex on raw as well—works when text already contains core digits/separators.
      let m;
      while ((m = PHONE_RE.exec(raw)) !== null) {
        const mStart = m.index;
        const mEnd = m.index + m[0].length;

        // Find items intersecting the match
        const usedItems = [];
        for (let s of L.spans) {
          if (s.itemIndex < 0) continue; // space we inserted
          // overlap?
          if (s.start < mEnd && s.end > mStart) {
            usedItems.push(L.items[s.itemIndex]);
          }
        }
        if (usedItems.length === 0) continue;

        // Bounding box in pdf.js viewport coords
        const minX = Math.min(...usedItems.map(u => u.x)) - PAD;
        const maxX = Math.max(...usedItems.map(u => u.x + u.width)) + PAD;
        const topY = Math.max(...usedItems.map(u => u.y)) + PAD;
        const bottomY = Math.min(...usedItems.map(u => u.y - u.height)) - PAD;

        // Convert to pdf-lib coords (origin bottom-left)
        const pdfX = minX * scaleX;
        const pdfWidth = (maxX - minX) * scaleX;
        // pdf.js y increases upward; viewport origin is top-left for drawing,
        // text transform y is baseline-ish; approximate rectangle:
        const pdfTopFromBottom = pageH - (topY * scaleY);
        const pdfHeight = (topY - bottomY) * scaleY;
        const pdfY = pdfTopFromBottom - pdfHeight;

        // White cover & draw replacement
        pdfPage.drawRectangle({
          x: pdfX,
          y: pdfY,
          width: pdfWidth,
          height: pdfHeight,
          color: { type: "RGB", r: 1, g: 1, b: 1 }
        });

        pdfPage.drawText(newNumber, {
          x: pdfX + 0.5,
          y: pdfY + 0.5,
          size: DRAW_SIZE,
          font,
          // You can tune size or y-offset if needed
          maxWidth: pdfWidth - 1
        });
      }
    }
  }

  const outBytes = await outDoc.save();
  return outBytes;
}

// ------- Overlay & Rebuild (kept for completeness) -------
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

async function rebuildPdf(pdfBytes, newNumber) {
  const src = await PDFDocument.load(pdfBytes);
  const out = await PDFDocument.create();
  const font = await embedUnicodeFont(out);

  const text = (await pdfParse(pdfBytes)).text || "";
  const replaced = normalizeWeird(text).replace(PHONE_RE, newNumber);

  const first = src.getPages()[0];
  const w = first?.getWidth?.() || 612;
  const h = first?.getHeight?.() || 792;

  // simple single-page (or split into multiple if you want)
  const p = out.addPage([w, h]);
  p.drawText(replaced.slice(0, 8000), {
    x: 36, y: h - 72, size: 10, lineHeight: 12, font, maxWidth: w - 72
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

    let out;
    if (mode === "rebuild") out = await rebuildPdf(pdfBytes, newNumber);
    else if (mode === "overlay") out = await overlayPreview(pdfBytes, newNumber);
    else out = await inplaceReplace(pdfBytes, newNumber); // default keep-layout

    const base64 = Buffer.from(out).toString("base64");
    res.status(200).json({
      fileName: (pdfUrl.split("/").pop() || "output.pdf").replace(/[^a-zA-Z0-9._-]/g, "_"),
      preview: "In-place replacement complete (layout preserved).",
      downloadUrl: `data:application/pdf;base64,${base64}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
