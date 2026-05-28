import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Dataset, DatasetSample } from "../types";

interface Props {
  dataset: Dataset;
  onSelect: (question: string, answer: string) => void;
}

interface PageResponse {
  total: number;
  page: number;
  page_size: number;
  samples: DatasetSample[];
  /** MASBench-only facet metadata. Older datasets return empty arrays. */
  axes?: string[];
  complexities_by_axis?: Record<string, string[]>;
}

const PAGE_SIZE = 10;

export function DatasetPicker({ dataset, onSelect }: Props) {
  const [samples, setSamples] = useState<DatasetSample[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Facet state — only ever populated for MASBench. We keep separate
  // axis / complexity selections so the user can pick "depth" and then
  // narrow to "depth = 12" without losing their place.
  const [axes, setAxes] = useState<string[]>([]);
  const [complexitiesByAxis, setComplexitiesByAxis] = useState<Record<string, string[]>>({});
  const [axisFilter, setAxisFilter] = useState<string>("");        // "" = Any
  const [complexityFilter, setComplexityFilter] = useState<string>(""); // "" = Any

  // Reset filters + page whenever the user switches reasoning dataset.
  useEffect(() => {
    setPage(0);
    setSamples([]);
    setTotal(0);
    setAxes([]);
    setComplexitiesByAxis({});
    setAxisFilter("");
    setComplexityFilter("");
  }, [dataset]);

  // Reset page when filters change so the user lands on the first
  // matching question, not deep inside the previous result set.
  useEffect(() => {
    setPage(0);
  }, [axisFilter, complexityFilter]);

  // Clear an out-of-range complexity if the user changes axes (e.g. a
  // complexity of "18" only exists under "horizon"; pivoting to
  // "breadth" must drop it rather than silently filtering to zero rows).
  useEffect(() => {
    if (!axisFilter) return;
    const allowed = complexitiesByAxis[axisFilter] ?? [];
    if (complexityFilter && !allowed.includes(complexityFilter)) {
      setComplexityFilter("");
    }
  }, [axisFilter, complexitiesByAxis, complexityFilter]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(PAGE_SIZE),
    });
    if (axisFilter) params.set("axis", axisFilter);
    if (complexityFilter) params.set("complexity", complexityFilter);
    fetch(`/dataset/${dataset}?${params.toString()}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PageResponse>;
      })
      .then(data => {
        setSamples(data.samples);
        setTotal(data.total);
        if (data.axes && data.axes.length) {
          setAxes(data.axes);
        }
        if (data.complexities_by_axis) {
          setComplexitiesByAxis(data.complexities_by_axis);
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [dataset, page, axisFilter, complexityFilter]);

  // Hover-preview state for the full question text. The list container
  // uses ``overflow-y-auto`` which would clip an inline tooltip, so we
  // portal the popover into ``document.body`` and position it with
  // ``position: fixed`` against the hovered row's bounding rect. This
  // matches the enterprise-mode pattern of giving the user a clean look
  // at otherwise-truncated content on hover.
  const [hovered, setHovered] = useState<{
    sample: DatasetSample;
    top: number;
    left: number;
    width: number;
    placeAbove: boolean;
  } | null>(null);

  const showPreview = (e: React.MouseEvent<HTMLButtonElement>, s: DatasetSample) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const padding = 8;
    // 480px popover. Prefer right-of-row; if it'd run off the viewport,
    // fall back to underneath the row. Flip above when there's no room
    // below either.
    const popWidth = Math.min(480, window.innerWidth - 2 * padding);
    let left = rect.right + padding;
    let placeAbove = false;
    if (left + popWidth > window.innerWidth - padding) {
      left = Math.max(padding, rect.left);
    }
    if (left + popWidth > window.innerWidth - padding) {
      left = window.innerWidth - popWidth - padding;
    }
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < 160 && rect.top > 200) {
      placeAbove = true;
    }
    const top = placeAbove ? rect.top - padding : rect.bottom + padding;
    setHovered({ sample: s, top, left, width: popWidth, placeAbove });
  };

  const hidePreview = () => setHovered(null);

  // Hide preview when paging or filtering so a stale popover doesn't
  // dangle while the list refreshes underneath.
  useEffect(() => { setHovered(null); }, [page, axisFilter, complexityFilter, dataset]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const showFacets = axes.length > 0;

  // The complexity dropdown options depend on the selected axis. When
  // no axis is chosen we union all complexities across axes so the
  // selector still works as a coarse cross-axis filter (sorted
  // numerically when possible).
  const complexityOptions = useMemo(() => {
    if (axisFilter) return complexitiesByAxis[axisFilter] ?? [];
    const all = new Set<string>();
    for (const list of Object.values(complexitiesByAxis)) {
      for (const v of list) all.add(v);
    }
    return Array.from(all).sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }, [axisFilter, complexitiesByAxis]);

  return (
    <div className="border rounded-lg overflow-hidden">
      {showFacets && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-gray-50 border-b text-xs text-gray-600">
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500">Axis</span>
            <select
              value={axisFilter}
              onChange={e => setAxisFilter(e.target.value)}
              className="px-1.5 py-0.5 border rounded bg-white text-gray-800 capitalize focus:outline-none focus:ring-1 focus:ring-blue-300"
            >
              <option value="">Any</option>
              {axes.map(a => (
                <option key={a} value={a} className="capitalize">{a}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-gray-500">Complexity</span>
            <select
              value={complexityFilter}
              onChange={e => setComplexityFilter(e.target.value)}
              className="px-1.5 py-0.5 border rounded bg-white text-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-300"
              disabled={complexityOptions.length === 0}
            >
              <option value="">Any</option>
              {complexityOptions.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          {(axisFilter || complexityFilter) && (
            <button
              onClick={() => { setAxisFilter(""); setComplexityFilter(""); }}
              className="ml-auto px-2 py-0.5 text-[11px] text-gray-500 hover:text-gray-800 hover:bg-white border border-transparent hover:border-gray-200 rounded"
              title="Clear filters"
            >
              Reset
            </button>
          )}
        </div>
      )}

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
              onMouseEnter={(e) => showPreview(e, s)}
              onMouseLeave={hidePreview}
              onFocus={(e) => showPreview(e as unknown as React.MouseEvent<HTMLButtonElement>, s)}
              onBlur={hidePreview}
              className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors"
            >
              {(s.axis || s.complexity) && (
                <div className="flex items-center gap-1 mb-1">
                  {s.axis && (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-50 text-blue-700 border border-blue-100 capitalize">
                      {s.axis}
                    </span>
                  )}
                  {s.complexity && (
                    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-100 text-gray-600 border border-gray-200">
                      complexity {s.complexity}
                    </span>
                  )}
                </div>
              )}
              <span className="line-clamp-2 text-gray-800">{s.question}</span>
            </button>
          </li>
        ))}
        {!loading && samples.length === 0 && !error && (
          <li className="px-3 py-4 text-sm text-gray-400 text-center">
            {showFacets && (axisFilter || complexityFilter)
              ? "No questions match this filter — try Reset."
              : "No samples"}
          </li>
        )}
      </ul>

      {/* Full-question hover preview — portaled so it can escape the
          list's overflow:auto clipping. Positioned next to (or above)
          the hovered row. Pointer-events disabled so it never traps
          the mouse and triggers a hide-flicker loop. */}
      {hovered && createPortal(
        <div
          style={{
            position: "fixed",
            top: hovered.placeAbove ? undefined : hovered.top,
            bottom: hovered.placeAbove ? window.innerHeight - hovered.top : undefined,
            left: hovered.left,
            width: hovered.width,
            zIndex: 60,
          }}
          className="pointer-events-none rounded-lg border border-gray-200 bg-white shadow-xl p-3 text-sm text-gray-800 leading-relaxed max-h-[60vh] overflow-y-auto"
        >
          {(hovered.sample.axis || hovered.sample.complexity) && (
            <div className="flex items-center gap-1 mb-2">
              {hovered.sample.axis && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-50 text-blue-700 border border-blue-100 capitalize">
                  {hovered.sample.axis}
                </span>
              )}
              {hovered.sample.complexity && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-100 text-gray-600 border border-gray-200">
                  complexity {hovered.sample.complexity}
                </span>
              )}
            </div>
          )}
          <div className="whitespace-pre-wrap break-words">{hovered.sample.question}</div>
          {hovered.sample.answer && (
            <div className="mt-2 pt-2 border-t border-gray-100 text-[11px] text-gray-500">
              Expected answer: <span className="font-mono text-gray-700">{hovered.sample.answer}</span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
