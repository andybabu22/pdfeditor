// pages/api/aiProcess.js
import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
import OpenAI from "openai";
import fontkit from "@pdf-lib/fontkit";

export const config = { api: { bodyParser: true, sizeLimit: "25mb" } };

// Unicode TTF fetched at runtime (no local font files needed)
const FONT_URL =
  "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

// Max text sent to the LLM to avoid token/size issues
const MAX_INPUT_CHARS = 12000;

export default async function handler(req, res) {
  try {
    // ---- Validate env & inputs
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: "OPENAI_API_KEY missing" });
    }

    const { pdfUrl, newNumber } = req.body || {};
    if (!pdfUrl || !newNumber) {
      return res
        .status(400)
        .json({ error: "Missing pdfUrl or newNumber in request body" });
    }

    // ---- Fetch source PDF
    const pdfResp = await fetch(pdfUrl);
    if (!pdfResp.ok) {
      throw new Error(`Failed to fetch PDF (${pdfResp.status})`);
    }
    const pdfArrayBuf = await pdfResp.arrayBuffer();
    const pdfData = Buffer.from(pdfArrayBuf);

    // ---- Extract text
    const extracted = await pdfParse(pdfData);
    const originalText = (extracted?.text || "").trim();

    // ---- Build LLM prompt (truncate safely)
    const prompt =
      `Find and replace all phone numbers (any format, incl. symbols and spelled-out digits) in the following text with ${newNumber}.\n` +
      `Return ONLY the modified text, no extra commentary.\n\n` +
      originalText.slice(0, MAX_INPUT_CHARS);

    // ---- OpenAI call (smart model options)
    const client = new OpenAI({ apiKey });
    const model = process.env.OPENAI_MODEL || "gpt-5";

    // Only include temperature for models that support it.
    // gpt-5 requires default temperature (1) and rejects overrides.
    const payload = {
      model,
      messages: [{ role: "user", content: prompt }],
    };
    if (!/^gpt-5/i.test(model)) {
      // Safer, more deterministic output for older models
      payload.temperature = 0;
    }

    const completion = await client.chat.completions.create(payload);

    let newText =
      completion?.choices?.[0]?.message?.content?.trim() || "";

    // Fallback: if model returned empty, do a conservative local replace
    if (!newText) {
      const phoneRegex = /(\+?\d[\d\s•\-().⇄⇋–_]{7,}\d)/g;
      const normalize = (txt) =>
        txt.replace(/[⇄⇋•–_]+/g, "-").replace(/\s{2,}/g, " ");
      newText = normalize(originalText).replace(phoneRegex, newNumber);
    }

    // ---- Rebuild output PDF with Unicode font (fixes ℗/™/® issues)
    const pdfDoc = await PDFDocument.load(pdfData);
    pdfDoc.registerFontkit(fontkit);

    const fontRes = await fetch(FONT_URL, { cache: "no-store" });
    if (!fontRes.ok) {
      throw new Error(`Font download failed (${fontRes.status})`);
    }
    const fontBytes = new Uint8Array(await fontRes.arrayBuffer());
    const unicodeFont = await pdfDoc.embedFont(fontBytes, { subset: true });

    const page = pdfDoc.getPages()[0];

    // Keep preview block modest to avoid text overflow on the page.
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

    return res.status(200).json({
      fileName: pdfUrl.split("/").pop(),
      preview: newText.substring(0, 500),
      downloadUrl: `data:application/pdf;base64,${base64}`,
    });
  } catch (err) {
    // Helpful error for logs + user
    console.error("aiProcess error:", err);
    const msg =
      typeof err?.message === "string" ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}
