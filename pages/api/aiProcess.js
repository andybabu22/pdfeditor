// pages/api/aiProcess.js
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
import OpenAI from "openai";
import fontkit from "@pdf-lib/fontkit";

export const config = { api: { bodyParser: true, sizeLimit: "25mb" } };

const FONT_URL =
  "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

const VANITY_MAP = {
  A:"2",B:"2",C:"2", D:"3",E:"3",F:"3", G:"4",H:"4",I:"4",
  J:"5",K:"5",L:"5", M:"6",N:"6",O:"6", P:"7",Q:"7",R:"7",S:"7",
  T:"8",U:"8",V:"8", W:"9",X:"9",Y:"9",Z:"9"
};
const MAX_INPUT_CHARS = 12000;

function normalizeWeird(text){
  return text
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g,"")
    .replace(/[⇄⇋•·–—_]+/g,"-")
    .replace(/([A-Za-z])(\d)/g,"$1 $2")
    .replace(/(\d)([A-Za-z])/g,"$1 $2")
    .replace(/\s{2,}/g," ")
    .trim();
}
function convertVanityToDigits(s){
  return s.replace(
    /\b(1[\s-]?8(?:00|33|44|55|66|77|88)[\s-]?)([A-Za-z][A-Za-z-]{3,})\b/gi,
    (_,prefix,word)=>prefix + word.replace(/[^A-Za-z]/g,"").toUpperCase().split("").map(ch=>VANITY_MAP[ch]||"").join("")
  );
}
function collapseSpelledDigits(s){
  const map = { zero:"0", one:"1", two:"2", three:"3", four:"4", five:"5", six:"6", seven:"7", eight:"8", nine:"9" };
  return s.replace(
    /(?:(?:\bzero|one|two|three|four|five|six|seven|eight|nine\b)\s*(?:-|–|—)?\s*){7,}/gi,
    m => m.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/gi, (_,w)=>map[w.toLowerCase()]).replace(/[^\d]+/g,"")
  );
}
function buildPhoneRegex(){ return /(\+?\d[\d\s\-().]{7,}\d)/g; }

async function embedUnicodeFont(pdfDoc){
  pdfDoc.registerFontkit(fontkit);
  const r = await fetch(FONT_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`Font download failed (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return pdfDoc.embedFont(bytes, { subset: true });
}

function paginateTextToPages(pdfDoc, font, text, pageW, pageH, margin = 36, size = 10, lineH = 12){
  const maxWidth = pageW - margin * 2;
  const maxLines = Math.floor((pageH - margin * 2) / lineH);
  const words = text.split(/\s+/);
  const widthOf = (t) => font.widthOfTextAtSize(t, size);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (widthOf(t) <= maxWidth) cur = t;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) {
    pages.push(lines.slice(i, i + maxLines).join("\n"));
  }
  return pages;
}

export default async function handler(req, res){
  try{
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "OPENAI_API_KEY missing" });

    const { pdfUrl, newNumber } = req.body || {};
    if (!pdfUrl || !newNumber) return res.status(400).json({ error: "Missing pdfUrl or newNumber" });

    const pdfResp = await fetch(pdfUrl);
    if (!pdfResp.ok) throw new Error(`Failed to fetch PDF (${pdfResp.status})`);
    const pdfBuf = Buffer.from(await pdfResp.arrayBuffer());
    const extracted = await pdfParse(pdfBuf);
    const original = (extracted?.text || "").trim();

    // Normalize before sending to LLM (improves recall)
    let norm = normalizeWeird(original);
    norm = convertVanityToDigits(norm);
    norm = collapseSpelledDigits(norm);

    const prompt =
      `Find and replace all phone numbers (any format, incl. symbols and spelled-out digits) in the following text with ${newNumber}. ` +
      `Return ONLY the modified text, no extra commentary.\n\n` +
      norm.slice(0, MAX_INPUT_CHARS);

    const client = new OpenAI({ apiKey });
    const model = process.env.OPENAI_MODEL || "gpt-5";
    const payload = { model, messages: [{ role: "user", content: prompt }] };
    if (!/^gpt-5/i.test(model)) payload.temperature = 0;

    const resp = await client.chat.completions.create(payload);
    let replaced = resp?.choices?.[0]?.message?.content?.trim() || "";

    // Fallback local replace if model returns nothing
    if (!replaced) {
      const phoneRegex = buildPhoneRegex();
      replaced = norm.replace(phoneRegex, newNumber);
    }

    const srcDoc = await PDFDocument.load(pdfBuf);
    const outDoc = await PDFDocument.create();
    const font = await embedUnicodeFont(outDoc);

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
  } catch (err) {
    console.error("aiProcess error:", err);
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
