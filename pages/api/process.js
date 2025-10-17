// pages/api/process.js
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
import fontkit from "@pdf-lib/fontkit";

export const config = { api: { bodyParser: true, sizeLimit: "25mb" } };

// Unicode font (runtime fetch, no local files needed)
const FONT_URL =
  "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

// Phone keypad mapping for vanity numbers (e.g., 1-800-COINBASE)
const VANITY_MAP = {
  A: "2", B: "2", C: "2",
  D: "3", E: "3", F: "3",
  G: "4", H: "4", I: "4",
  J: "5", K: "5", L: "5",
  M: "6", N: "6", O: "6",
  P: "7", Q: "7", R: "7", S: "7",
  T: "8", U: "8", V: "8",
  W: "9", X: "9", Y: "9", Z: "9"
};

function normalizeWeird(text) {
  return text
    // strip zero-width & soft hyphen
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "")
    // unify odd separators to hyphen
    .replace(/[⇄⇋•·–—_]+/g, "-")
    // split letters/digits glued together (CALL1-888 -> CALL 1-888)
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    // collapse multiple spaces
    .replace(/\s{2,}/g, " ")
    .trim();
}

function convertVanityToDigits(s) {
  // toll-free vanity like 1-800-COINBASE (and similar 833/844/855/866/877/888)
  return s.replace(
    /\b(1[\s-]?8(?:00|33|44|55|66|77|88)[\s-]?)([A-Za-z][A-Za-z-]{3,})\b/gi,
    (_, prefix, word) => {
      const digits = word
        .replace(/[^A-Za-z]/g, "")
        .toUpperCase()
        .split("")
        .map(ch => VANITY_MAP[ch] || "")
        .join("");
      return digits ? prefix + digits : prefix + word;
    }
  );
}

// Optional: collapse long sequences of spelled-out digits into numbers
function collapseSpelledDigits(s) {
  const map = {
    zero: "0", one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9"
  };
  // Only apply when there are 7+ digit-words in a row
  return s.replace(
    /(?:(?:\bzero|one|two|three|four|five|six|seven|eight|nine\b)\s*(?:-|–|—)?\s*){7,}/gi,
    m =>
      m.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/gi,
                 (_, w) => map[w.toLowerCase()] )
       .replace(/[^\d]+/g, "")
  );
}

function buildPhoneRegex() {
  // At least 9 digits total, allowing separators and parens (works after normalization)
  return /(\+?\d[\d\s\-().]{7,}\d)/g;
}

async function embedUnicodeFont(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  const fontRes = await fetch(FONT_URL, { cache: "no-store" });
  if (!fontRes.ok) throw new Error(`Font download failed (${fontRes.status})`);
  const fontBytes = new Uint8Array(await fontRes.arrayBuffer());
  return pdfDoc.embedFont(fontBytes, { subset: true });
}

// Simple paginator: wraps text to width/height using font metrics
function paginateTextToPages(pdfDoc, font, text, pageW, pageH, margin = 36, size = 10, lineH = 12) {
  const maxWidth = pageW - margin * 2;
  const maxLines = Math.floor((pageH - margin * 2) / lineH);

  // naive word wrap
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";

  const widthOf = (t) => font.widthOfTextAtSize(t, size);

  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (widthOf(test) <= maxWidth) {
      cur = test;
    } else {
      if (cur) lines.push(cur);
      // very long token fallback
      if (widthOf(w) > maxWidth) {
        let token = w, chunk = "";
        for (const ch of token) {
          const t2 = chunk + ch;
          if (widthOf(t2) <= maxWidth) chunk = t2;
          else { lines.push(chunk); chunk = ch; }
        }
        if (chunk) cur = chunk;
        else cur = "";
      } else {
        cur = w;
      }
    }
  }
  if (cur) lines.push(cur);

  // paginate
  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    pages.push(lines.slice(i, i + maxLines).join("\n"));
  }
  return pages;
}

export default async function handler(req, res) {
  try {
    const { pdfUrl, newNumber, mode = "rebuild" } = req.body || {};
    if (!pdfUrl || !newNumber) {
      return res.status(400).json({ error: "Missing pdfUrl or newNumber" });
    }

    // 1) Fetch original PDF & extract text
    const pdfResp = await fetch(pdfUrl);
    if (!pdfResp.ok) throw new Error(`Failed to fetch PDF (${pdfResp.status})`);
    const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
    const extracted = await pdfParse(pdfBuf);
    let text = extracted?.text || "";

    // 2) Normalize + vanity + spelled-out handling
    text = normalizeWeird(text);
    text = convertVanityToDigits(text);
    text = collapseSpelledDigits(text);

    // 3) Replace using robust regex
    const phoneRegex = buildPhoneRegex();
    const replaced = text.replace(phoneRegex, newNumber);

    if (mode === "overlay") {
      // (old behavior) overlay a preview block on page 1 of original file
      const pdfDoc = await PDFDocument.load(pdfBuf);
      const font = await embedUnicodeFont(pdfDoc);
      const page = pdfDoc.getPages()[0];
      const previewChunk = replaced.slice(0, 1800);
      page.drawText(previewChunk, {
        x: 36, y: page.getHeight() - 72,
        size: 10, lineHeight: 12, font,
        maxWidth: page.getWidth() - 72
      });
      const out = await pdfDoc.save();
      return res.status(200).json({
        fileName: pdfUrl.split("/").pop(),
        preview: replaced.substring(0, 500),
        downloadUrl: `data:application/pdf;base64,${Buffer.from(out).toString("base64")}`
      });
    }

    // 4) REBUILD MODE (default): new PDF with full replaced text (makes sure ALL numbers are replaced)
    const srcDoc = await PDFDocument.load(pdfBuf);
    const outDoc = await PDFDocument.create();
    const font = await embedUnicodeFont(outDoc);

    // keep same page size as original for the first page; default to Letter if unknown
    const firstSrcPage = srcDoc.getPages()[0];
    const pageW = firstSrcPage?.getWidth?.() || 612;
    const pageH = firstSrcPage?.getHeight?.() || 792;

    const pages = paginateTextToPages(outDoc, font, replaced, pageW, pageH);
    if (pages.length === 0) pages.push("(empty)");

    for (const block of pages) {
      const p = outDoc.addPage([pageW, pageH]);
      p.drawText(block, {
        x: 36, y: pageH - 72,
        size: 10, lineHeight: 12, font,
        maxWidth: pageW - 72
      });
    }

    const out = await outDoc.save();
    return res.status(200).json({
      fileName: (pdfUrl.split("/").pop() || "output.pdf").replace(/[^a-zA-Z0-9._-]/g, "_"),
      preview: replaced.substring(0, 500),
      downloadUrl: `data:application/pdf;base64,${Buffer.from(out).toString("base64")}`
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
