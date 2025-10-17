// pages/api/process.js
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
import fontkit from "@pdf-lib/fontkit";

export const config = { api: { bodyParser: true, sizeLimit: "25mb" } };

const FONT_URL =
  "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

function normalizeWeird(text) {
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "")
    .replace(/[⇄⇋•·–—_]+/g, "-")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

const VANITY_MAP = {A:"2",B:"2",C:"2",D:"3",E:"3",F:"3",G:"4",H:"4",I:"4",J:"5",K:"5",L:"5",M:"6",N:"6",O:"6",P:"7",Q:"7",R:"7",S:"7",T:"8",U:"8",V:"8",W:"9",X:"9",Y:"9",Z:"9"};
function convertVanityToDigits(s) {
  return s.replace(
    /\b(1[\s-]?8(?:00|33|44|55|66|77|88)[\s-]?)([A-Za-z][A-Za-z-]{3,})\b/gi,
    (_, prefix, word) => {
      const digits = word
        .replace(/[^A-Za-z]/g, "")
        .toUpperCase()
        .split("")
        .map((ch) => VANITY_MAP[ch] || "")
        .join("");
      return prefix + (digits || word);
    }
  );
}

async function embedUnicodeFont(pdfDoc) {
  pdfDoc.registerFontkit(fontkit);
  const r = await fetch(FONT_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Font download failed (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return pdfDoc.embedFont(bytes, { subset: true });
}

function paginateText(pdfDoc, font, text, pageW, pageH, {
  margin = 36, size = 11, lineH = 14
} = {}) {
  const maxWidth = pageW - margin * 2;
  const maxLines = Math.floor((pageH - margin * 2) / lineH);
  const words = text.split(/\s+/);
  const widthOf = (t) => font.widthOfTextAtSize(t, size);

  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (widthOf(t) <= maxWidth) cur = t;
    else {
      if (cur) lines.push(cur);
      if (widthOf(w) > maxWidth) {
        let chunk = "";
        for (const ch of w) {
          const t2 = chunk + ch;
          if (widthOf(t2) <= maxWidth) chunk = t2;
          else { lines.push(chunk); chunk = ch; }
        }
        cur = chunk;
      } else {
        cur = w;
      }
    }
  }
  if (cur) lines.push(cur);

  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    pages.push(lines.slice(i, i + maxLines).join("\n"));
  }
  return { pages, size, lineH, margin };
}

function toPresentable(text, newNumber) {
  let t = convertVanityToDigits(normalizeWeird(text));
  t = t.replace(PHONE_RE, newNumber);
  const rawLines = t.split(/\r?\n/).map((s) => s.trim());
  const nonEmpty = rawLines.filter(Boolean);
  const title = nonEmpty[0] || "Document";
  const subtitle = (nonEmpty[1] && nonEmpty[1].length < 120) ? nonEmpty[1] : "";
  const bodyLines = [];
  const seen = new Set();
  for (const line of rawLines.slice(1)) {
    if (!line) { bodyLines.push(""); continue; }
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if ((line.match(/\d/g) || []).length >= 7 && line.replace(/\D/g, "").length < 4) continue;
    bodyLines.push(line);
  }
  const bullets = [];
  const paragraphs = [];
  let para = [];
  for (const line of bodyLines) {
    if (!line) { if (para.length) { paragraphs.push(para.join(" ")); para = []; } continue; }
    if (/^(?:[-•·*]|(\d+\.))\s+/.test(line)) {
      if (para.length) { paragraphs.push(para.join(" ")); para = []; }
      bullets.push(line.replace(/^(?:[-•·*]|\d+\.)\s+/, "• "));
    } else {
      para.push(line);
    }
  }
  if (para.length) paragraphs.push(para.join(" "));
  return { title, subtitle, bullets, paragraphs };
}

async function overlayPreview(pdfBytes, newNumber) {
  const text = (await pdfParse(pdfBytes)).text || "";
  const replaced = normalizeWeird(text.replace(PHONE_RE, newNumber));
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await embedUnicodeFont(pdfDoc);
  const page = pdfDoc.getPages()[0];
  const chunk = replaced.slice(0, 1800);
  page.drawText(chunk, {
    x: 36, y: page.getHeight() - 72, size: 10, lineHeight: 12, font,
    maxWidth: page.getWidth() - 72
  });
  return await pdfDoc.save();
}

async function rebuildPdf(pdfBytes, newNumber) {
  const out = await PDFDocument.create();
  const font = await embedUnicodeFont(out);
  const text = (await pdfParse(pdfBytes)).text || "";
  const replaced = normalizeWeird(text).replace(PHONE_RE, newNumber);
  const page = out.addPage([612, 792]);
  page.drawText(replaced.slice(0, 8000), {
    x: 36, y: 792 - 72, size: 10, lineHeight: 12, font, maxWidth: 612 - 72
  });
  return await out.save();
}

async function presentablePdf(pdfBytes, newNumber) {
  const out = await PDFDocument.create();
  const font = await embedUnicodeFont(out);
  const extracted = await pdfParse(pdfBytes);
  const raw = extracted?.text || "";
  const { title, subtitle, bullets, paragraphs } = toPresentable(raw, newNumber);
  let pageW = 612, pageH = 792;
  try {
    const src = await PDFDocument.load(pdfBytes);
    const first = src.getPages()[0];
    pageW = first?.getWidth?.() || pageW;
    pageH = first?.getHeight?.() || pageH;
  } catch {}
  let page = out.addPage([pageW, pageH]);
  let cursorY = pageH - 72;
  const titleSize = 20, subSize = 14, bodySize = 11, lineH = 14, margin = 36;
  page.drawText(title, { x: margin, y: cursorY, size: titleSize, font, maxWidth: pageW - margin * 2, lineHeight: 22 });
  cursorY -= 30;
  if (subtitle) {
    page.drawText(subtitle, { x: margin, y: cursorY, size: subSize, font, maxWidth: pageW - margin * 2, lineHeight: 18 });
    cursorY -= 26;
  }
  const ensure = (need) => {
    if (cursorY - need < 36) { page = out.addPage([pageW, pageH]); cursorY = pageH - 72; }
  };
  if (bullets.length) {
    bullets.forEach((b) => {
      const block = paginateText(out, font, b, pageW, pageH, { margin, size: bodySize, lineH });
      block.pages.forEach((paraPage) => {
        const lines = paraPage.split("\n").length;
        ensure(block.size + block.lineH * lines);
        page.drawText(paraPage, { x: margin, y: cursorY, size: bodySize, font, lineHeight: lineH, maxWidth: pageW - margin * 2 });
        cursorY -= (lines * lineH) + 4;
      });
    });
    cursorY -= 4;
  }
  for (const para of paragraphs) {
    const block = paginateText(out, font, para, pageW, pageH, { margin, size: bodySize, lineH });
    block.pages.forEach((paraPage) => {
      const lines = paraPage.split("\n").length;
      ensure(block.size + block.lineH * lines);
      page.drawText(paraPage, { x: margin, y: cursorY, size: bodySize, font, lineHeight: lineH, maxWidth: pageW - margin * 2 });
      cursorY -= lines * lineH + 10;
    });
  }
  return await out.save();
}

export default async function handler(req, res) {
  try {
    const { pdfUrl, newNumber, mode = "presentable" } = req.body || {};
    if (!pdfUrl || !newNumber) {
      return res.status(400).json({ error: "Missing pdfUrl or newNumber" });
    }
    const resp = await fetch(pdfUrl);
    if (!resp.ok) throw new Error(`Failed to fetch PDF (${resp.status})`);
    const pdfBytes = Buffer.from(await resp.arrayBuffer());
    let outBytes;
    if (mode === "overlay") outBytes = await overlayPreview(pdfBytes, newNumber);
    else if (mode === "rebuild") outBytes = await rebuildPdf(pdfBytes, newNumber);
    else outBytes = await presentablePdf(pdfBytes, newNumber);
    const base64 = Buffer.from(outBytes).toString("base64");
    res.status(200).json({
      fileName: (pdfUrl.split("/").pop() || "output.pdf").replace(/[^a-zA-Z0-9._-]/g, "_"),
      preview: "Heading preserved; body cleaned and reflowed.",
      downloadUrl: `data:application/pdf;base64,${base64}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
