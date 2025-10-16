# pdfeditor

Dual‑mode PDF phone number replacer. Paste multiple PDF URLs, enter a replacement number, and download edited PDFs (single or ZIP). Works on Vercel.

## Modes
- **Local Detection (default):** regex + normalization, no API key required.
- **AI Mode (optional):** GPT‑5 for semantic detection. Add `.env.local` with `OPENAI_API_KEY`.

## Setup
```bash
npm install
npm run dev
# optional: cp .env.local.example .env.local and set your key
vercel deploy
```

## Notes
- This demo overlays replaced text chunk onto the first page to produce a downloadable edited PDF quickly.
- In‑place replacement within the original layout requires a more advanced text positioning pipeline (pdf.js text spans + reflow), which can be added later.
