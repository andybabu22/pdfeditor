# pdfeditor by andy (Unicode-safe)

Vercel-ready Next.js app that replaces phone numbers in PDFs.
- Local mode (regex + normalization) — no API key needed
- AI mode (GPT-5) — set OPENAI_API_KEY in `.env.local`
- Unicode font is fetched **at runtime** (no local font files)

## Deploy steps
1) Push to GitHub
2) On Vercel:
   - Framework Preset: Next.js
   - Root Directory: repo root (folder containing `pages/` and `package.json`)
   - Build Command: `npm run build`
   - Output Directory: **leave blank**
   - Redeploy (clear build cache if needed)

## Dev
```bash
npm install
npm run dev
```

