import { useEffect, useRef, useState } from "react";
import { readStoredAuthUser } from "../hooks/useAuth";

type Mode = "idle" | "sending" | "sent" | "failed";

interface Props {
  open: boolean;
  onClose: () => void;
  // Captured automatically and sent along to help the dev team
  // reproduce / debug what the user was looking at.
  contextSnapshot?: Record<string, unknown>;
}

const FALLBACK_EMAIL = "zixuan.ke@salesforce.com";

/** Contact-us modal. Mirrors the friendly tone of the share modal:
 *  a centered card with a short pitch + textarea + submit. On success
 *  we show a "thanks" state; on failure we surface the developer email
 *  from the paper so the user has an unambiguous fallback path. */
export function ContactModal({ open, onClose, contextSnapshot }: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [failDetail, setFailDetail] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<string>(FALLBACK_EMAIL);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset everything on open/close so a previous "Thanks!" doesn't
  // bleed into the next session, and the textarea takes focus.
  useEffect(() => {
    if (!open) return;
    setMode("idle");
    setFailDetail(null);
    // Don't clear the message on every open — the user may want to
    // resume drafting after dismissing the modal.
    setTimeout(() => textareaRef.current?.focus(), 30);
  }, [open]);

  // Esc to close, ⌘/Ctrl-Enter to submit from anywhere.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit()) {
        e.preventDefault();
        submit();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, message, mode]);

  const canSubmit = () => message.trim().length > 0 && mode !== "sending";

  const submit = async () => {
    if (!canSubmit()) return;
    setMode("sending");
    setFailDetail(null);
    try {
      // Attach the signed-in user (if any) so the dev team can map
      // the feedback back to a known account without forcing the
      // user to re-type their email.
      const authedUser = readStoredAuthUser();
      const res = await fetch("/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          user_email: email.trim() || authedUser?.email || null,
          user_sub: authedUser?.sub ?? null,
          context: contextSnapshot ?? {
            url: typeof window !== "undefined" ? window.location.href : "",
            ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.to) setRecipient(String(data.to));
      if (data?.sent) {
        setMode("sent");
      } else {
        setMode("failed");
        setFailDetail(String(data?.detail || "Email delivery is not configured on this server."));
      }
    } catch (err) {
      setMode("failed");
      setFailDetail(err instanceof Error ? err.message : String(err));
    }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden border border-gray-200"
      >
        <div className="px-5 py-4 border-b bg-gradient-to-br from-pink-50 via-white to-amber-50 flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-pink-500 to-rose-500 text-white flex items-center justify-center text-base shadow-sm">
            💬
          </div>
          <div className="leading-tight">
            <div className="text-base font-semibold text-gray-900">We'd love your input</div>
            <div className="text-[11px] text-gray-500">Your feedback shapes what we build next — please share!</div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto text-gray-400 hover:text-gray-700 px-2 py-1 text-sm rounded-md hover:bg-gray-100"
            title="Close"
          >
            ✕
          </button>
        </div>

        {mode === "sent" ? (
          <div className="p-6 text-center space-y-3">
            <div className="text-5xl">🎉</div>
            <div className="text-base font-semibold text-gray-900">Thanks — sent to the dev team!</div>
            <p className="text-sm text-gray-600 max-w-sm mx-auto">
              We read every message. If you left an email, expect a reply when we ship the next iteration.
            </p>
            <button
              onClick={onClose}
              className="mt-2 px-4 py-2 rounded-lg text-sm font-medium bg-gradient-to-br from-pink-600 to-rose-600 text-white hover:from-pink-700 hover:to-rose-700 shadow-sm"
            >
              You're awesome — close
            </button>
          </div>
        ) : mode === "failed" ? (
          <div className="p-5 space-y-3">
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-semibold mb-1">We couldn't deliver your message from here.</div>
              <p className="text-[12px] leading-relaxed">
                Please email the dev team directly at{" "}
                <a
                  href={`mailto:${recipient}?subject=${encodeURIComponent("[MAS-Orchestra] Feedback")}&body=${encodeURIComponent(message)}`}
                  className="font-mono underline text-amber-900 hover:text-amber-700"
                >
                  {recipient}
                </a>
                {" "}so we can fix it. (The address is also in the paper.) Sorry for the friction!
              </p>
              {failDetail && (
                <div className="mt-2 text-[10.5px] text-amber-700/80 font-mono">{failDetail}</div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setMode("idle")}
                className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-md border border-gray-200 hover:bg-gray-50"
              >
                Edit message
              </button>
              <a
                href={`mailto:${recipient}?subject=${encodeURIComponent("[MAS-Orchestra] Feedback")}&body=${encodeURIComponent(message)}`}
                className="text-xs text-white bg-gradient-to-br from-pink-600 to-rose-600 hover:from-pink-700 hover:to-rose-700 px-3 py-1.5 rounded-md font-medium"
              >
                Open in mail app →
              </a>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-3">
            <p className="text-sm text-gray-700 leading-relaxed">
              Comments, use-cases, bug reports, feature wishes — anything you tell us makes the demo better.
              We read everything personally.
            </p>
            <textarea
              ref={textareaRef}
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={6}
              placeholder="What did you try? What surprised you? What would you build with this?"
              disabled={mode === "sending"}
              className="w-full text-sm px-3 py-2 border border-gray-200 rounded-lg outline-none focus:border-pink-400 focus:ring-1 focus:ring-pink-300 resize-y min-h-[7rem] max-h-72 placeholder:text-gray-400"
            />
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-gray-500 shrink-0">Email (optional)</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={mode === "sending"}
                className="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded-md outline-none focus:border-pink-400 focus:ring-1 focus:ring-pink-300 placeholder:text-gray-400"
              />
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="text-[10.5px] text-gray-400">
                {mode === "sending"
                  ? "Sending…"
                  : "⌘/Ctrl + Enter to submit"}
              </div>
              <button
                onClick={submit}
                disabled={!canSubmit()}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition shadow-sm flex items-center gap-1.5 ${
                  canSubmit()
                    ? "bg-gradient-to-br from-pink-600 to-rose-600 text-white hover:from-pink-700 hover:to-rose-700"
                    : "bg-gray-100 text-gray-400 cursor-not-allowed"
                }`}
              >
                {mode === "sending" ? (
                  <>
                    <span className="w-3 h-3 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
                    Sending…
                  </>
                ) : (
                  <>
                    <span>💌</span>
                    Send to dev team
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
