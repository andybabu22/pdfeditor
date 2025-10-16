import { useState } from 'react';
import { motion } from 'framer-motion';


export default function Home() {
const [pdfUrls, setPdfUrls] = useState('');
const [replaceNumber, setReplaceNumber] = useState('');
const [aiMode, setAiMode] = useState(false);
const [loading, setLoading] = useState(false);
const [results, setResults] = useState([]);


const handleProcess = async () => {
setLoading(true);
const urls = pdfUrls.split(/\n|,/).map(u => u.trim()).filter(Boolean);
const processed = [];
for (const url of urls) {
const endpoint = aiMode ? '/api/aiProcess' : '/api/process';
const res = await fetch(endpoint, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ pdfUrl: url, newNumber: replaceNumber })
});
const data = await res.json();
processed.push(data);
}
setResults(processed);
setLoading(false);
};


return (
<div className="min-h-screen p-8">
<motion.h1 initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-3xl font-bold mb-6 text-center">
📄 Smart PDF Replacer
</motion.h1>
<div className="max-w-2xl mx-auto space-y-4">
<textarea value={pdfUrls} onChange={e => setPdfUrls(e.target.value)} placeholder="Enter PDF URLs (one per line)"
className="w-full p-3 border rounded" rows={4}></textarea>
<input value={replaceNumber} onChange={e => setReplaceNumber(e.target.value)} placeholder="Enter replacement phone number"
className="w-full p-3 border rounded" />
<button onClick={() => setAiMode(!aiMode)} className={`px-4 py-2 rounded text-white ${aiMode ? 'bg-purple-600' : 'bg-gray-700'}`}>
{aiMode ? 'AI Mode (GPT-5) ON' : 'Local Detection'}
</button>
<button disabled={loading} onClick={handleProcess} className="bg-blue-600 text-white px-6 py-3 rounded w-full">
{loading ? 'Processing...' : 'Start Processing'}
</button>
</div>


{results.length > 0 && (
<div className="mt-10 space-y-6">
{results.map((r, i) => (
<div key={i} className="border p-4 rounded bg-white shadow-sm">
<h3 className="font-semibold text-lg">{r.fileName || `File ${i + 1}`}</h3>
<p className="text-sm text-gray-500 mb-2">Replaced numbers with: {replaceNumber}</p>
<a href={r.downloadUrl} target="_blank" className="text-blue-600 underline">Download PDF</a>
{r.preview && (
<pre className="mt-3 bg-gray-50 p-2 text-sm overflow-x-auto rounded border">{r.preview}</pre>
)}
</div>
))}
</div>
)}
</div>
);
}