// pages/index.js
// Smart PDF Replacer UI
// - Paste multiple PDF URLs (one per line)
// - Enter a replacement number
// - Choose: Local vs AI Mode (GPT)
// - Choose: Keep Layout (in-place) vs Rebuild
// - Progress bar while processing
// - Per-file download + simple PDF preview
// - Download All (ZIP)

import { useState } from "react";
import { motion } from "framer-motion";
import JSZip from "jszip";

export default function Home() {
  // Inputs
  const [pdfUrls, setPdfUrls] = useState("");
  const [replaceNumber, setReplaceNumber] = useState("");

  // Toggles
  const [aiMode, setAiMode] = useState(false);        // Local by default; no key required
  const [keepLayout, setKeepLayout] = useState(true); // Keep original layout by default (in-place)

  // State
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]); // [{fileName, sourceUrl, downloadUrl, preview, error}]
  const [error, setError] = useState("");

  // Progress bar
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(0);
  const percent = progressTotal ? Math.round((progressDone / progressTotal) * 100) : 0;

  // Track preview visibility per result (index -> boolean)
  const [openPreview, setOpenPreview] = useState({});

  const togglePreview = (idx) =>
    setOpenPreview((prev) => ({ ...prev, [idx]: !prev[idx] }));

  // Convert data URL -> bytes for zipping
  const dataURLtoUint8Array = (dataURL) => {
    const base64 = dataURL.split(",")[1];
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const handleProcess = async () => {
    setError("");
    setResults([]);
    setProgressDone(0);
    setOpenPreview({});

    // Split URLs (newline or comma)
    const urls = pdfUrls.split(/\n|,/).map((u) => u.trim()).filter(Boolean);
    if (!urls.length) {
      setError("Please enter at least one PDF URL.");
      return;
    }
    if (!replaceNumber.trim()) {
      setError("Please enter the replacement phone number.");
      return;
    }

    setProgressTotal(urls.length);
    setLoading(true);

    const processed = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const endpoint = aiMode ? "/api/aiProcess" : "/api/process";
        const body = {
          pdfUrl: url,
          newNumber: replaceNumber,
          mode: keepLayout ? "inplace" : "rebuild", // "inplace" keeps headings/format
        };

        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json();
        processed.push({ ...data, sourceUrl: url });
      } catch (e) {
        processed.push({
          fileName: url.split("/").pop() || "file.pdf",
          sourceUrl: url,
          error: e.message || String(e),
        });
      }

      setProgressDone((prev) => prev + 1);
    }

    setResults(processed);
    setLoading(false);
  };

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

        {/* Toggles + Start */}
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            onClick={() => setAiMode(!aiMode)}
            className={`px-4 py-2 rounded text-white ${
              aiMode ? "bg-purple-600" : "bg-gray-700"
            }`}
            title="AI Mode uses your OpenAI key in Vercel → Settings → Environment Variables."
          >
            {aiMode ? "AI Mode (GPT) ON" : "Local Detection"}
          </button>

          <button
            onClick={() => setKeepLayout(!keepLayout)}
            className="px-4 py-2 rounded text-white bg-slate-700"
            title="Keep Layout = in-place replacement (headings/format preserved). Rebuild = clean text PDF."
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

              {/* Simple inline PDF preview */}
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
