import { useState, useEffect } from "react";
import type { Dataset, DatasetSample } from "../types";

interface Props {
  dataset: Dataset;
  onSelect: (question: string, answer: string) => void;
}

const PAGE_SIZE = 10;

export function DatasetPicker({ dataset, onSelect }: Props) {
  const [samples, setSamples] = useState<DatasetSample[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPage(0);
    setSamples([]);
    setTotal(0);
  }, [dataset]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/dataset/${dataset}?page=${page}&page_size=${PAGE_SIZE}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        setSamples(data.samples);
        setTotal(data.total);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [dataset, page]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b">
        <span className="text-xs font-medium text-gray-500">
          {loading ? "Loading…" : `${total} questions`}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0 || loading}
              className="px-2 py-0.5 text-xs border rounded hover:bg-white disabled:opacity-40"
            >
              ←
            </button>
            <span className="text-xs text-gray-500">{page + 1} / {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1 || loading}
              className="px-2 py-0.5 text-xs border rounded hover:bg-white disabled:opacity-40"
            >
              →
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-red-600 bg-red-50">{error}</div>
      )}

      <ul className="divide-y max-h-64 overflow-y-auto">
        {samples.map((s, i) => (
          <li key={i}>
            <button
              onClick={() => onSelect(s.question, s.answer)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors"
            >
              <span className="line-clamp-2 text-gray-800">{s.question}</span>
            </button>
          </li>
        ))}
        {!loading && samples.length === 0 && !error && (
          <li className="px-3 py-4 text-sm text-gray-400 text-center">No samples</li>
        )}
      </ul>
    </div>
  );
}
