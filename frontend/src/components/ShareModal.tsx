import { useEffect, useRef, useState } from "react";

type Mode = "idle" | "creating" | "ready" | "error";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreate: () => Promise<{ id: string; url: string } | null>;
  // Light-weight summary used to render a preview card so the modal doesn't
  // feel empty while the share link is being generated.
  summary?: {
    problem: string;
    agentCount: number;
    hasAnswer: boolean;
  };
}

export function ShareModal({ open, onClose, onCreate, summary }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const startedRef = useRef(false);

  // When the modal opens, kick off share-link creation eagerly so the user
  // doesn't have to wait after clicking "Copy".
  useEffect(() => {
    if (!open) {
      setMode("idle");
      setShareUrl(null);
      setErrorMsg(null);
      setCopied(false);
      startedRef.current = false;
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    setMode("creating");
    onCreate()
      .then(res => {
        if (!res) {
          setMode("error");
          setErrorMsg("Could not create share link. Please try again.");
          return;
        }
        setShareUrl(res.url);
        setMode("ready");
      })
      .catch(err => {
        setMode("error");
        setErrorMsg(String(err));
      });
  }, [open, onCreate]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback: select the text input
      const el = document.getElementById("share-url-input") as HTMLInputElement | null;
      el?.select();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm animate-[fadeIn_120ms_ease-out]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
    >
      <div
        className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header band */}
        <div className="relative px-6 pt-6 pb-5 bg-gradient-to-br from-blue-50 via-white to-indigo-50 border-b border-gray-100">
          <button
            onClick={onClose}
            className="absolute top-3 right-3 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-white/70"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center flex-none shadow-sm">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4-4 4M12 2v14" />
              </svg>
            </div>
            <div className="leading-tight">
              <h2 id="share-modal-title" className="text-base font-semibold text-gray-900">Share this conversation</h2>
              <p className="text-xs text-gray-500 mt-0.5">Anyone with the link can view your problem, plan, and result — read-only.</p>
            </div>
          </div>

          {summary && (
            <div className="mt-4 rounded-lg bg-white border border-gray-200 px-3 py-2.5 flex items-center gap-3 shadow-sm">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">Problem</div>
                <div className="text-xs text-gray-800 truncate">{summary.problem || "(empty)"}</div>
              </div>
              <div className="flex items-center gap-1.5 flex-none">
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100 font-medium">
                  {summary.agentCount} agent{summary.agentCount === 1 ? "" : "s"}
                </span>
                {summary.hasAnswer && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100 font-medium">
                    answered
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Link block */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Share link</div>
              {mode === "creating" && (
                <span className="text-[11px] text-gray-400 flex items-center gap-1.5">
                  <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                  Generating…
                </span>
              )}
            </div>
            <div className="flex items-stretch gap-2">
              <input
                id="share-url-input"
                readOnly
                value={mode === "ready" && shareUrl ? shareUrl : ""}
                placeholder={mode === "creating" ? "Generating share link…" : "Share link will appear here"}
                onFocus={e => e.currentTarget.select()}
                className="flex-1 min-w-0 text-xs font-mono px-3 py-2 rounded-md border border-gray-300 bg-gray-50 text-gray-700 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-300"
              />
              <button
                onClick={handleCopy}
                disabled={mode !== "ready"}
                className={`px-3.5 py-2 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors flex-none ${
                  copied
                    ? "bg-emerald-600 text-white"
                    : "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300"
                }`}
              >
                {copied ? (
                  <>
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd"/></svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                    Copy link
                  </>
                )}
              </button>
            </div>
            {mode === "error" && (
              <div className="mt-2 text-[11px] text-red-600 bg-red-50 border border-red-100 rounded px-2 py-1">
                {errorMsg}
              </div>
            )}
            <div className="mt-2 text-[11px] text-gray-400">
              Recipients open the link in a browser — no sign-in required.
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
