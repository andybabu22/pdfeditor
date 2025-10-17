import { useState } from "react";
import { motion } from "framer-motion";
import JSZip from "jszip";

export default function Home() {
  // Inputs
  const [pdfUrls, setPdfUrls] = useState("");
  const [replaceNumber, setReplaceNumber] = useState("");

  // Toggles
  const [aiMode, setAiMode] = useState(false);     // OFF by default (no API key needed)
  const [rebuild, setRebuild] = useState(true);    // REBUILD mode by default (recommended)

  // State
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");

  // Progress bar
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(0);
  const percent = progressTotal ? Math.round((progressDone / progressTotal) * 100) : 0;

  // Convert data URL -> bytes for JSZip
  const dataURLtoUint8Array = (dataURL) => {
    const base64 = dataURL.split(",")[1];
    if (typeof window === "undefined") {
      const buf = Buffer.from(base64, "base64");
      return new Uint8Array(buf);
    }
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

    const urls = pdfUrls.split(/\n|,/).map(u => u.trim()).filter(Boolean);
    if (!urls.length) { setError("Please enter at least one PDF URL."); return; }
    if (!replaceNumber.trim()) { setError("Please enter the replacement phone number."); return; }

    setProgressTotal(urls.length);
    setLoading(true);

    const processed = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const endpoint = aiMode ? "/api/aiProcess" : "/api/process";
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pdfUrl: url,
            newNumber: replaceNumber,
            mode: rebuild ? "rebuild" : "overlay",
          }),
        });

        const data = await res.json();
        processed.push({ ...data, sourceUrl: url });
      } catch (e) {
        processed.push({ fileName: url.split("/").pop(), sourceUrl: url, error: e.message });
      }

      // update progress bar
      setProgressDone(prev => prev + 1);
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
      const name = (r.fileName || `file_${idx + 1}.pdf`).replace(/[^a-zA-Z0-9._-]/g, "_");
      folder.file(name, bytes);
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
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-3xl font-bold mb-6 text-center text-blue-700"
      >
        📄 Smart PDF Replacer
      </motion.h1>

      {/* Progress bar (top) */}
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
        <textarea
          value={pdfUrls}
          onChange={(e) => setPdfUrls(e.target.value)}
          placeholder="Enter PDF URLs (one per line)"
          className="w-full p-3 border rounded"
          rows={5}
        />
        <input
          value={replaceNumber}
          onChange={(e) => setReplaceNumber(e.target.value)}
          placeholder="Enter replacement phone number"
          className="w-full p-3 border rounded"
        />

        {/* Toggles */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setAiMode(!aiMode)}
            className={`px-4 py-2 rounded text-white ${aiMode ? "bg-purple-600" : "bg-gray-700"}`}
            title="Use GPT mode (requires OPENAI_API_KEY in Vercel → Settings → Environment Variables)"
          >
            {aiMode ? "AI Mode (GPT) ON" : "Local Detection"}
          </button>

          <button
            onClick={() => setRebuild(!rebuild)}
            className="px-4 py-2 rounded text-white bg-slate-700"
            title="Rebuild = new PDF from replaced text (recommended). Overlay = stamp preview on page 1."
          >
            {rebuild ? "Layout: Rebuild (All Replaced)" : "Layout: Overlay (Preview Only)"}
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
                <h3 className="font-semibold text-lg truncate">{r.fileName || `File ${i + 1}`}</h3>
                {r.downloadUrl && (
                  <a href={r.downloadUrl} download className="text-blue-600 underline">
                    Download PDF
                  </a>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1 break-all">Source: {r.sourceUrl || "—"}</p>
              {r.error && <p className="text-red-600 mt-2">Error: {r.error}</p>}
              {r.preview && (
                <div className="mt-3">
                  <h4 className="font-medium mb-1">Preview (first 500 chars after replace)</h4>
                  <pre className="bg-gray-50 p-2 text-sm overflow-x-auto rounded border whitespace-pre-wrap">
                    {r.preview}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
