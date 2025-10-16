import { PDFDocument, StandardFonts } from "pdf-lib";
import pdfParse from "pdf-parse";
import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: "OPENAI_API_KEY missing" });

    const { pdfUrl, newNumber } = req.body || {};
    if (!pdfUrl || !newNumber) return res.status(400).json({ error: "Missing pdfUrl or newNumber" });

    const response = await fetch(pdfUrl);
    if (!response.ok) throw new Error(`Failed to fetch PDF (${response.status})`);
    const arrayBuf = await response.arrayBuffer();
    const pdfData = Buffer.from(arrayBuf);

    const text = (await pdfParse(pdfData)).text || "";

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = "Find and replace all phone numbers (any format, symbols, or spelled-out digits) in the following text with " + newNumber + ". Return only the modified text, no extra commentary.\n\n" + text.substring(0, 12000);

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-5",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    });

    const newText = completion.choices?.[0]?.message?.content || "";

    const pdfDoc = await PDFDocument.load(pdfData);
    const firstPage = pdfDoc.getPages()[0];
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const previewChunk = newText.slice(0, 1800);
    firstPage.drawText(previewChunk, {
      x: 36,
      y: firstPage.getHeight() - 72,
      size: 10,
      lineHeight: 12,
      font,
      maxWidth: firstPage.getWidth() - 72,
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
