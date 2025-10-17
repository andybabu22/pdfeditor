// pages/api/aiProcess.js
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
import fontkit from "@pdf-lib/fontkit";
import OpenAI from "openai";

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

function extractTitleAndBody(raw) {
  const lines = raw.split(/\r?\n/).map(s => s.trim());
  const title = (lines.find(Boolean) || "Document");
  const idx = lines.findIndex(Boolean);
  const body = idx >= 0 ? lines.slice(idx + 1).join("\n") : raw;
  return { title, body };
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

export default async function handler(req, res) {
  try {
    const { pdfUrl, newNumber } = req.body || {};
    if (!pdfUrl || !newNumber) {
      return res.status(400).json({ error: "Missing pdfUrl or newNumber" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "OPENAI_API_KEY is missing in environment variables." });
    }

    const resp = await fetch(pdfUrl);
    if (!resp.ok) throw new Error(`Failed to fetch PDF (${resp.status})`);
    const pdfBytes = Buffer.from(await resp.arrayBuffer());

    const extracted = await pdfParse(pdfBytes);
    const raw = extracted?.text || "";
    const norm = convertVanityToDigits(normalizeWeird(raw));
    const { title, body } = extractTitleAndBody(norm);

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-5";
    const instruction = `You are a text-normalization assistant. 
Replace ALL phone numbers (any format, including symbols, vanity like 1-800-FLOWERS, or spaced/obfuscated) with: ${newNumber}.
Then lightly clean and reflow the content for readability:
- Preserve headings if present; do NOT invent new content.
- Keep bullet lists as simple lines starting with "• " where appropriate.
- Remove blatant repetitions of contact lines.
Return ONLY the cleaned text (no markdown, no code fences).`;

    const ai = await client.responses.create({
      model,
      input: [
        { role: "system", content: instruction },
        { role: "user", content: body }
      ]
    });

    let cleaned = "";
    try {
      if (ai.output_text) cleaned = ai.output_text;
      else if (ai.output && ai.output[0] && ai.output[0].content && ai.output[0].content[0]) {
        cleaned = ai.output[0].content[0].text || "";
      } else if (ai.choices && ai.choices[0] && ai.choices[0].message) {
        cleaned = ai.choices[0].message.content || "";
      }
    } catch {}
    cleaned = (cleaned || "").trim();
    if (!cleaned) throw new Error("OpenAI returned empty text.");

    // Build presentable PDF with heading kept verbatim
    const out = await PDFDocument.create();
    out.registerFontkit(fontkit);
    const font = await embedUnicodeFont(out);

    let pageW = 612, pageH = 792;
    try {
      const src = await PDFDocument.load(pdfBytes);
      const first = src.getPages()[0];
      pageW = first?.getWidth?.() || pageW;
      pageH = first?.getHeight?.() || pageH;
    } catch {}

    let page = out.addPage([pageW, pageH]);
    let cursorY = pageH - 72;
    const titleSize = 20, bodySize = 11, lineH = 14, margin = 36;

    page.drawText(title, {
      x: margin, y: cursorY, size: titleSize, font, maxWidth: pageW - margin * 2, lineHeight: 22
    });
    cursorY -= 30;

    const ensure = (need) => {
      if (cursorY - need < 36) {
        page = out.addPage([pageW, pageH]);
        cursorY = pageH - 72;
      }
    };

    const block = paginateText(out, font, cleaned, pageW, pageH, { margin, size: bodySize, lineH });
    block.pages.forEach((paraPage) => {
      const lines = paraPage.split("\n").length;
      ensure(block.size + block.lineH * lines);
      page.drawText(paraPage, {
        x: margin, y: cursorY, size: bodySize, font, lineHeight: lineH, maxWidth: pageW - margin * 2
      });
      cursorY -= lines * lineH + 10;
    });

    const outBytes = await out.save();
    const base64 = Buffer.from(outBytes).toString("base64");
    res.status(200).json({
      fileName: (pdfUrl.split("/").pop() || "output.pdf").replace(/[^a-zA-Z0-9._-]/g, "_"),
      preview: "Heading preserved; AI-cleaned body with all numbers replaced.",
      downloadUrl: `data:application/pdf;base64,${base64}`
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
