// pages/index.js
// Smart PDF Replacer UI
// - Paste multiple PDF URLs (one per line)
// - Enter a replacement number
// - Choose: Local vs AI Mode (GPT)
// - Choose: Keep Layout (in-place, client-side) vs Rebuild (server-side)
// - Progress bar while processing
// - Per-file download + simple PDF preview
// - Download All (ZIP)

import { useState } from "react";
import { motion } from "framer-motion";
import JSZip from "jszip";

// Unicode font to embed when drawing replacements
const FONT_URL =
  "https://raw.githubusercontent.com/GreatWizard/notosans-fontface/master/fonts/NotoSans-Regular.ttf";

// Phone-like detection + normalization (client-side mirror of server)
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;
const normalizeWeird = (text) =>
  text
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "") // zero-width + soft hyphen
    .replace(/[⇄⇋•·–—_]+/g, "-")                // unify odd separators
    .replace(/\s{2,}/g, " ")
    .trim();

export default function Home() {
  // Inputs
  const [pdfUrls, setPdfUrls] = useState("");
  const [replaceNumber, setReplaceNumber] = useState("");

  // Toggles
  const [aiMode, setAiMode] = useState(false);       // Local by default; no key required
  const [keepLayout, setKeepLayout] = useState(true); // Keep original layout by default (in-place on client)

  // State
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]); // [{fileName, sourceUrl, downloadUrl, preview, error}]
  const [error, setError] = useState("");

  // Progress bar
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(0);
  const percent = progressTotal ? Math.round((progressDone / progressTotal) * 100) : 0;

  // Preview
  const [openPreview, setOpenPreview] = useState({});
  const togglePreview = (idx) =>
    setOpenPreview((prev) => ({ ...prev, [idx]: !prev[idx] }));

  // Helpers
  const dataURLtoUint8Array = (dataURL) => {
    const base64 = dataURL.split(",")[1];
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const arrayBufferToDataUrl = (mime, ab) => {
    const bytes = new Uint8Array(ab);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const base64 = btoa(bin);
    return `data:${mime};base64,${base64}`;
  };

  // ---- CLIENT-SIDE IN-PLACE (Keep Layout) ----
  const processInplaceClient = async (pdfArrayBuffer, newNumber) => {
    // Dynamic imports (only on client)
    const pdfLibMod = await import("pdf-lib");
    const fontkitMod = await import("@pdf-lib/fontkit");
    const pdfjsMod = await import("pdfjs-dist");

    // Normalize module shapes
    const PDFDocument = pdfLibMod.PDFDocument ?? pdfLibMod.default?.PDFDocument;
    const fontkit = fontkitMod.default || fontkitMod;

    const pdfjs = pdfjsMod.default?.getDocument ? pdfjsMod.default : pdfjsMod;
    const version = pdfjs.version || pdfjsMod.version || "4.7.76";

    // ✅ Set PDF.js worker (fixes "No GlobalWorkerOptions.workerSrc specified")
    const workerSrc = `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`;
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    }

    // Load source into pdf-lib (for drawing) and pdf.js (for text positions)
    const srcBytes = new Uint8Array(pdfArrayBuffer);
    const pdfDoc = await PDFDocument.load(srcBytes);
    pdfDoc.registerFontkit(fontkit);

    const fontRes = await fetch(FONT_URL, { cache: "no-store" });
    if (!fontRes.ok) throw new Error(`Font download failed (${fontRes.status})`);
    const fontBytes = new Uint8Array(await fontRes.arrayBuffer());
    const uniFont = await pdfDoc.embedFont(fontBytes, { subset: true });

    const loadingTask = pdfjs.getDocument({ data: srcBytes, disableWorker: true });
    const jsDoc = await loadingTask.promise;

    // Tunables for line grouping & drawing
    const PAD = 1.5;
    const LINE_Y_TOL = 2.0;
    const WORD_GAP_TOL = 2.0;
    const DRAW_SIZE = 10;

    for (let i = 1; i <= jsDoc.numPages; i++) {
      const jsPage = await jsDoc.getPage(i);
      const viewport = jsPage.getViewport({ scale: 1.0 });
      const content = await jsPage.getTextContent({ disableCombineTextItems: false });

      // Group items into lines
      const lines = [];
      for (const it of content.items) {
        const [, , c, d, e, f] = it.transform;
        const x = e;
        const y = f;
        const width = it.width;
        const height = it.height || Math.hypot(c, d);

        let line = lines.find((L) => Math.abs(L.yRef - y) <= LINE_Y_TOL);
        if (!line) {
          line = { yRef: y, items: [] };
          lines.push(line);
        }
        line.items.push({ str: it.str, x, y, width, height });
      }
      lines.sort((L1, L2) => L2.yRef - L1.yRef); // top → bottom
      lines.forEach((L) => L.items.sort((a, b) => a.x - b.x)); // left → right

      // Build plain text per line + spans mapping
      for (const L of lines) {
        let text = "";
        const spans = []; // { start, end, itemIndex }
        for (let idx = 0; idx < L.items.length; idx++) {
          const it = L.items[idx];
          if (idx > 0) {
            const prev = L.items[idx - 1];
            const gap = it.x - (prev.x + prev.width);
            if (gap > WORD_GAP_TOL) {
              spans.push({ start: text.length, end: text.length + 1, itemIndex: -1 });
              text += " ";
            }
          }
          const start = text.length;
          text += it.str;
          spans.push({ start, end: text.length, itemIndex: idx });
        }
        L.text = text;
        L.spans = spans;
      }

      const page = pdfDoc.getPage(i - 1);
      const pageW = page.getWidth();
      const pageH = page.getHeight();
      const scaleX = pageW / viewport.width;
      const scaleY = pageH / viewport.height;

      for (const L of lines) {
        const raw = L.text || "";
        if (!raw) continue;

        // Run detection on raw (works after we normalize weird breaks earlier during extraction)
        let m;
        while ((m = PHONE_RE.exec(raw)) !== null) {
          const mStart = m.index;
          const mEnd = m.index + m[0].length;

          // Map match back to contributing items
          const usedItems = [];
          for (const s of L.spans) {
            if (s.itemIndex < 0) continue; // space we inserted
            if (s.start < mEnd && s.end > mStart) usedItems.push(L.items[s.itemIndex]);
          }
          if (!usedItems.length) continue;

          // Bounding box in pdf.js coords
          const minX = Math.min(...usedItems.map((u) => u.x)) - PAD;
          const maxX = Math.max(...usedItems.map((u) => u.x + u.width)) + PAD;
          const topY = Math.max(...usedItems.map((u) => u.y)) + PAD;
          const bottomY = Math.min(...usedItems.map((u) => u.y - u.height)) - PAD;

          // Convert to pdf-lib coords
          const pdfX = minX * scaleX;
          const pdfWidth = (maxX - minX) * scaleX;
          const pdfTopFromBottom = pageH - topY * scaleY;
          const pdfHeight = (topY - bottomY) * scaleY;
          const pdfY = pdfTopFromBottom - pdfHeight;

          // Cover + draw replacement
          page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: pdfWidth,
            height: pdfHeight,
            color: { type: "RGB", r: 1, g: 1, b: 1 },
          });
          page.drawText(newNumber, {
            x: pdfX + 0.5,
            y: pdfY + 0.5,
            size: DRAW_SIZE,
            font: uniFont,
            maxWidth: pdfWidth - 1,
          });
        }
      }
    }

    const out = await pdfDoc.save();
    return arrayBufferToDataUrl("application/pdf", out);
  };

  // ---- Main handler ----
  const handleProcess = async () => {
    setError("");
    setResults([]);
    setProgressDone(0);
    setOpenPreview({});

    const urls = pdfUrls.split(/\n|,/).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) { setError("Please enter at least one PDF URL."); return; }
    if (!replaceNumber.trim()) { setError("Please enter the replacement phone number."); return; }

    setProgressTotal(urls.length);
    setLoading(true);

    const processed = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        let data;

        if (keepLayout) {
          // In-place on client: fetch via proxy to avoid CORS
          const proxied = `/api/fetch?url=${encodeURIComponent(url)}`;
          const r = await fetch(proxied);
          if (!r.ok) throw new Error(`Fetch failed (${r.status})`);
          const arrBuf = await r.arrayBuffer();
          const downloadUrl = await processInplaceClient(arrBuf, replaceNumber);
          data = {
            fileName: url.split("/").pop() || `file_${i + 1}.pdf`,
            preview: "In-place replacement complete (layout preserved).",
            downloadUrl,
          };
        } else {
          // Rebuild/Overlay handled on the server (no pdfjs-dist on server)
          const endpoint = aiMode ? "/api/aiProcess" : "/api/process";
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pdfUrl: url,
              newNumber: replaceNumber,
              mode: "rebuild", // or "overlay" if you want to switch
            }),
          });
          data = await res.json();
        }

        processed.push({ ...data, sourceUrl: url });
      } catch (e) {
        processed.push({
          fileName: url.split("/").pop() || `file_${i + 1}.pdf`,
          sourceUrl: url,
          error: e.message || String(e),
        });
      }

      setProgressDone((prev) => prev + 1);
    }

    setResults(processed);
    setLoading(false);
  };

  // Download ZIP of all outputs
  const downloadAllZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("processed_pdfs");
    results.forEach((r, idx) => {
      if (!r.downloadUrl) return;
      const bytes = dataURLtoUint8Array(r.downloadUrl);
      const safeName = (r.fileName || `file_${idx + 1}.pdf`).replace(/[^a-zA-Z0-9._-]/g, "_");
      folder.file(safeName, bytes);
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "processed_pdfs.zip";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="min-h-screen p-8">
      {/* Title */}
      <motion.h1
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-3xl font-bold mb-6 text-center text-blue-700"
      >
        📄 Smart PDF Replacer
      </motion.h1>

      {/* Progress bar */}
      {loading && (
        <div className="max-w-3xl mx-auto mb-6">
          <div className="w-full bg-gray-200 h-3 rounded">
            <div
              className="h-3 bg-blue-600 rounded transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="text-sm text-gray-600 mt-1">
            Processing {progressDone}/{progressTotal} files ({percent}%)
          </div>
        </div>
      )}

      {/* Input card */}
      <div className="max-w-3xl mx-auto space-y-4 bg-white p-5 rounded-xl shadow">
        <label className="block text-sm font-medium text-gray-700">
          PDF URLs (one per line)
        </label>
        <textarea
          value={pdfUrls}
          onChange={(e) => setPdfUrls(e.target.value)}
          placeholder={`https://example.com/file1.pdf
https://example.com/file2.pdf`}
          className="w-full p-3 border rounded"
          rows={6}
        />

        <label className="block text-sm font-medium text-gray-700">
          Replacement phone number
        </label>
        <input
          value={replaceNumber}
          onChange={(e) => setReplaceNumber(e.target.value)}
          placeholder="+1-999-111-2222"
          className="w-full p-3 border rounded"
        />

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            onClick={() => setAiMode(!aiMode)}
            className={`px-4 py-2 rounded text-white ${aiMode ? "bg-purple-600" : "bg-gray-700"}`}
            title="AI Mode uses your OpenAI key in Vercel → Settings → Environment Variables."
          >
            {aiMode ? "AI Mode (GPT) ON" : "Local Detection"}
          </button>

          <button
            onClick={() => setKeepLayout(!keepLayout)}
            className="px-4 py-2 rounded text-white bg-slate-700"
            title="Keep Layout runs entirely in your browser (no server pdfjs)."
          >
            {keepLayout ? "Layout: Keep (In-place)" : "Layout: Rebuild (Plain Text)"}
          </button>

          <button
            disabled={loading}
            onClick={handleProcess}
            className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
          >
            {loading ? "Processing…" : "Start Processing"}
          </button>
        </div>

        {error && <div className="text-red-600 text-sm">{error}</div>}

        <p className="text-xs text-gray-500">
          Tip: For AI Mode, set <code>OPENAI_API_KEY</code> in Vercel → Project → Settings → Environment Variables.
        </p>
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="max-w-3xl mx-auto mt-10 space-y-6">
          <div className="flex justify-end">
            <button
              onClick={downloadAllZip}
              className="bg-emerald-600 text-white px-4 py-2 rounded hover:bg-emerald-700"
            >
              Download All (ZIP)
            </button>
          </div>

          {results.map((r, i) => (
            <div key={i} className="border p-4 rounded bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-semibold text-lg truncate">
                  {r.fileName || `File ${i + 1}`}
                </h3>
                <div className="flex items-center gap-3">
                  {r.downloadUrl && (
                    <>
                      <button
                        onClick={() => togglePreview(i)}
                        className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 text-sm"
                        title="Toggle PDF preview"
                      >
                        {openPreview[i] ? "Hide Preview" : "Preview"}
                      </button>
                      <a
                        href={r.downloadUrl}
                        download
                        className="text-blue-600 underline"
                        title="Download processed PDF"
                      >
                        Download PDF
                      </a>
                    </>
                  )}
                </div>
              </div>

              <p className="text-xs text-gray-500 mt-1 break-all">
                Source: {r.sourceUrl || "—"}
              </p>

              {r.error && <p className="text-red-600 mt-2">Error: {r.error}</p>}

              {r.preview && (
                <div className="mt-3">
                  <h4 className="font-medium mb-1">
                    {keepLayout
                      ? "Preview (layout kept — sample message)"
                      : "Preview (first 500 chars)"}
                  </h4>
                  <pre className="bg-gray-50 p-2 text-sm overflow-x-auto rounded border whitespace-pre-wrap">
                    {r.preview}
                  </pre>
                </div>
              )}

              {/* Inline PDF preview */}
              {openPreview[i] && r.downloadUrl && (
                <div className="mt-3">
                  <iframe
                    src={r.downloadUrl}
                    title={`preview-${i}`}
                    className="w-full h-[480px] border rounded"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
