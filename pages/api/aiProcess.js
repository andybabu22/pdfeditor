import fetch from 'node-fetch';
import pdfParse from 'pdf-parse';
import { PDFDocument } from 'pdf-lib';
import OpenAI from 'openai';


export default async function handler(req, res) {
try {
const { pdfUrl, newNumber } = req.body;
const response = await fetch(pdfUrl);
const buffer = await response.arrayBuffer();
const pdfData = Buffer.from(buffer);
const text = (await pdfParse(pdfData)).text;


const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const prompt = `Find and replace all phone numbers (any format) in the following text with ${newNumber}. Return modified text only.\n\n${text.substring(0, 12000)}`;
const completion = await client.chat.completions.create({
model: process.env.OPENAI_MODEL || 'gpt-5',
messages: [{ role: 'user', content: prompt }],
});
const newText = completion.choices[0].message.content;


const pdfDoc = await PDFDocument.load(pdfData);
const firstPage = pdfDoc.getPages()[0];
firstPage.drawText(newText.slice(0, 1000));


const outPdf = await pdfDoc.save();
const base64 = Buffer.from(outPdf).toString('base64');


res.status(200).json({
fileName: pdfUrl.split('/').pop(),
preview: newText.substring(0, 500),
downloadUrl: `data:application/pdf;base64,${base64}`
});
} catch (e) {
res.status(500).json({ error: e.message });
}
}