# Smart PDF Replacer (Next.js + Vercel)

Modes:
- **Presentable (default)**: keeps original heading exactly, cleans/reflows the rest, replaces all phone numbers with your number.
- **Keep Layout (in-place)**: client-side overlay; preserves layout and replaces numbers where they appear.
- **Plain Rebuild**: simple text-only output.

Optional **AI Mode**: set `OPENAI_API_KEY` (and `OPENAI_MODEL` like `gpt-5` or `gpt-4o-mini`) in Vercel → Project → Settings → Environment Variables.

## Quick Start
1. Download this repo ZIP and upload to GitHub.
2. Import into Vercel → will auto-detect Next.js.
3. (Optional) Add `OPENAI_API_KEY` in Vercel if using AI Mode.
4. Deploy.

## Files
- `pages/api/process.js` → server Presentable/Rebuild/Overlay
- `pages/api/aiProcess.js` → server Presentable powered by OpenAI (optional)
- `pages/api/fetch.js` → CORS-safe proxy for client in-place
- `pages/index.js` → UI (progress bar, previews, ZIP)
- Tailwind configured via `pages/_app.js`, `styles/globals.css`, `tailwind.config.js`, `postcss.config.js`

## Notes
- No `pdfjs-dist` import on server. Client-side in-place mode handles PDF.js worker via CDN automatically.
- If you see build cache issues in Vercel, Redeploy with **Clear build cache**.
