/* eslint-disable @typescript-eslint/no-explicit-any */
/* ─────────────────────────────────────────────────────────────────────
 * Tutorial — first-visit guided tour of the MAS-Orchestra demo.
 *
 * Renders a full-viewport dim overlay with an SVG-mask cutout around
 * the current step's target element (looked up via
 * ``[data-tutorial-id=…]``), plus a floating tooltip card that
 * auto-positions to stay on screen (preferred side first, flips when
 * it would overflow, falls back to center-modal if the target is
 * hidden / off-screen).
 *
 * Auto-launches on first visit. Skipping or completing sets
 * ``localStorage.tutorial_dismissed_v1`` so it never re-shows
 * automatically; users can always re-launch via the Help button in
 * the top bar. The "Don't show again" checkbox is for symmetry — both
 * Skip and Don't-show-again set the same flag (we make it a checkbox
 * rather than two separate buttons so the intent stays explicit).
 *
 * Bumping the schema version (``TUTORIAL_VERSION``) effectively
 * re-shows the tour to everyone once after a major UI change.
 * ──────────────────────────────────────────────────────────────────── */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const TUTORIAL_VERSION = "v1";
const DISMISSED_KEY = `tutorial_dismissed_${TUTORIAL_VERSION}`;

export type TutorialStep = {
  id: string;
  title: string;
  body: string;
  /** Selector for the target element — must be a stable
   *  ``[data-tutorial-id="…"]`` attribute on something visible in the
   *  current UI state. Falls back to center-modal if not found. */
  targetSelector: string;
  /** Preferred placement of the tooltip relative to the target. The
   *  component will flip / shift to keep it inside the viewport. */
  prefer?: "right" | "left" | "top" | "bottom";
  /** Optional callback fired when this step becomes active — handy
   *  for opening collapsed sections so the target is rendered. */
  onEnter?: () => void;
};

/* ───────── Public helpers ───────── */

/** True if the user has dismissed (skipped or completed) the tour for
 *  the current version. */
export function hasDismissedTutorial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setTutorialDismissed(dismissed: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (dismissed) window.localStorage.setItem(DISMISSED_KEY, "1");
    else window.localStorage.removeItem(DISMISSED_KEY);
  } catch {
    /* ignore quota / private-mode errors */
  }
}

/* ───────── Geometry ───────── */

type Rect = { top: number; left: number; width: number; height: number };

function readTargetRect(selector: string): Rect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  // Scroll the target into view if it's clipped — important when the
  // sidebar has many sections.
  const inView =
    r.top >= 0 && r.left >= 0 &&
    r.bottom <= (window.innerHeight || 0) &&
    r.right <= (window.innerWidth || 0);
  if (!inView) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" as ScrollBehavior });
  const r2 = el.getBoundingClientRect();
  return { top: r2.top, left: r2.left, width: r2.width, height: r2.height };
}

/** Inflate a target rect by a few pixels so the spotlight has breathing
 *  room and the rounded mask doesn't clip the highlighted control. */
function pad(rect: Rect, p: number): Rect {
  return {
    top: rect.top - p,
    left: rect.left - p,
    width: rect.width + p * 2,
    height: rect.height + p * 2,
  };
}

const TOOLTIP_W = 340;
const TOOLTIP_H_ESTIMATE = 220;
const GAP = 14;

/** Pick the best of {prefer, opposite, top, bottom, left, right} and
 *  return a clamped (top, left) origin for the tooltip. */
function placeTooltip(
  rect: Rect, prefer: TutorialStep["prefer"], vw: number, vh: number,
): { top: number; left: number; arrowSide: "right" | "left" | "top" | "bottom" } {
  const opposite = (p: TutorialStep["prefer"]): TutorialStep["prefer"] =>
    p === "right" ? "left" : p === "left" ? "right" : p === "top" ? "bottom" : "top";

  const order: TutorialStep["prefer"][] = [
    prefer ?? "right",
    opposite(prefer ?? "right"),
    "bottom",
    "top",
    "right",
    "left",
  ];

  const fits = (side: TutorialStep["prefer"]) => {
    if (side === "right") return rect.left + rect.width + GAP + TOOLTIP_W <= vw;
    if (side === "left") return rect.left - GAP - TOOLTIP_W >= 0;
    if (side === "bottom") return rect.top + rect.height + GAP + TOOLTIP_H_ESTIMATE <= vh;
    if (side === "top") return rect.top - GAP - TOOLTIP_H_ESTIMATE >= 0;
    return false;
  };

  const chosen = (order.find(s => fits(s)) ?? "bottom") as "right" | "left" | "top" | "bottom";

  let top = 0, left = 0;
  if (chosen === "right") {
    top = rect.top + rect.height / 2 - TOOLTIP_H_ESTIMATE / 2;
    left = rect.left + rect.width + GAP;
  } else if (chosen === "left") {
    top = rect.top + rect.height / 2 - TOOLTIP_H_ESTIMATE / 2;
    left = rect.left - GAP - TOOLTIP_W;
  } else if (chosen === "bottom") {
    top = rect.top + rect.height + GAP;
    left = rect.left + rect.width / 2 - TOOLTIP_W / 2;
  } else {
    top = rect.top - GAP - TOOLTIP_H_ESTIMATE;
    left = rect.left + rect.width / 2 - TOOLTIP_W / 2;
  }

  // Clamp to viewport with an 8-px margin so the card never kisses the edge.
  const margin = 8;
  top = Math.max(margin, Math.min(vh - TOOLTIP_H_ESTIMATE - margin, top));
  left = Math.max(margin, Math.min(vw - TOOLTIP_W - margin, left));
  return { top, left, arrowSide: chosen };
}

/* ───────── Component ───────── */

export function Tutorial({
  steps,
  open,
  onClose,
}: {
  steps: TutorialStep[];
  open: boolean;
  onClose: (reason: "skipped" | "completed" | "dismissed-checkbox") => void;
}) {
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [tick, setTick] = useState(0);            // forces recompute on resize/scroll
  const [dontShow, setDontShow] = useState(false);
  const lastEnterRef = useRef<string | null>(null);

  // Reset to step 0 each time the tour opens.
  useEffect(() => {
    if (open) {
      setIdx(0);
      setDontShow(false);
    }
  }, [open]);

  const step = steps[idx];

  // Fire onEnter when the active step changes (and when the tour
  // first opens). Guarded by a ref so we don't fire twice for the
  // same step during re-renders.
  useEffect(() => {
    if (!open || !step) return;
    const key = `${idx}:${step.id}`;
    if (lastEnterRef.current === key) return;
    lastEnterRef.current = key;
    try { step.onEnter?.(); } catch { /* ignore */ }
  }, [open, idx, step]);

  // Resolve the target rect. We re-read on every tick (set by resize /
  // scroll / interval), and use a 100ms interval so we catch layout
  // shifts from sibling animations / lazy-rendered sections.
  useLayoutEffect(() => {
    if (!open || !step) return;
    const measure = () => setRect(readTargetRect(step.targetSelector));
    measure();
    const onResize = () => setTick(t => t + 1);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    const id = window.setInterval(() => setTick(t => t + 1), 250);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
      window.clearInterval(id);
    };
  }, [open, step]);

  // Recompute the rect on every tick (cheap — just a getBoundingClientRect).
  useEffect(() => {
    if (!open || !step) return;
    setRect(readTargetRect(step.targetSelector));
  }, [tick, open, step]);

  // Keyboard navigation: ←/→/Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (dontShow) setTutorialDismissed(true);
        onClose("skipped");
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        e.preventDefault();
        setIdx(i => Math.min(steps.length - 1, i + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIdx(i => Math.max(0, i - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, steps.length, dontShow, onClose]);

  const handleSkip = useCallback(() => {
    if (dontShow) setTutorialDismissed(true);
    onClose("skipped");
  }, [dontShow, onClose]);

  const handleDone = useCallback(() => {
    // Completing the tour ALWAYS sets the dismissed flag — finishing
    // the tour means you've seen everything, no reason to ever
    // auto-show it again. Re-launch via the Help button.
    setTutorialDismissed(true);
    onClose("completed");
  }, [onClose]);

  const handleDontShowToggle = useCallback((checked: boolean) => {
    setDontShow(checked);
    setTutorialDismissed(checked);
  }, []);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  const placed = useMemo(() => {
    if (!rect) return null;
    return placeTooltip(pad(rect, 6), step?.prefer, vw, vh);
  }, [rect, step, vw, vh]);

  if (!open || !step) return null;

  const padded = rect ? pad(rect, 6) : null;
  const r = 10; // mask corner radius

  return (
    <div className="fixed inset-0 z-[1000]" aria-modal="true" role="dialog">
      {/* Dim overlay with a cutout around the target. SVG mask handles
          the cutout so we get smooth rounded edges. When there's no
          target rect (lookup failed, element off-screen) we render a
          plain dim layer + a center-modal tooltip — graceful degrade. */}
      <svg
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: "auto" }}
        onClick={handleSkip}
      >
        <defs>
          <mask id="mas-tutorial-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {padded && (
              <rect
                x={padded.left}
                y={padded.top}
                width={padded.width}
                height={padded.height}
                rx={r}
                ry={r}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0" y="0" width="100%" height="100%"
          fill="rgba(15, 23, 42, 0.55)"
          mask="url(#mas-tutorial-mask)"
        />
        {/* Pulsing outline ring on the target for extra affordance. */}
        {padded && (
          <rect
            x={padded.left}
            y={padded.top}
            width={padded.width}
            height={padded.height}
            rx={r}
            ry={r}
            fill="none"
            stroke="rgba(59, 130, 246, 0.9)"
            strokeWidth="2"
            style={{ pointerEvents: "none" }}
            className="mas-tutorial-pulse"
          />
        )}
      </svg>

      {/* Tooltip card. position:absolute so clicks on it don't bubble
          to the overlay's onClick (which would close the tour). */}
      <div
        className="absolute bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden"
        style={{
          top: placed ? placed.top : Math.max(40, vh / 2 - TOOLTIP_H_ESTIMATE / 2),
          left: placed ? placed.left : Math.max(40, vw / 2 - TOOLTIP_W / 2),
          width: TOOLTIP_W,
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-blue-600">
            Tour · {idx + 1} of {steps.length}
          </div>
          <button
            onClick={handleSkip}
            title="Close the tour"
            className="text-gray-400 hover:text-gray-600 text-base leading-none"
          >
            ×
          </button>
        </div>
        <div className="px-4 pb-3">
          <div className="text-base font-semibold text-gray-900 mb-1">{step.title}</div>
          <p className="text-[13px] text-gray-600 leading-snug">{step.body}</p>
        </div>
        <div className="flex items-center justify-between border-t bg-gray-50/70 px-4 py-2.5 gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={e => handleDontShowToggle(e.target.checked)}
              className="accent-blue-600 w-3 h-3"
            />
            Don&apos;t show again
          </label>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleSkip}
              className="text-[12px] text-gray-600 hover:text-gray-900 px-2.5 py-1.5 rounded-md hover:bg-gray-100 font-medium"
            >
              Skip
            </button>
            {idx > 0 && (
              <button
                onClick={() => setIdx(i => Math.max(0, i - 1))}
                className="text-[12px] text-gray-700 hover:text-gray-900 px-2.5 py-1.5 rounded-md border border-gray-200 hover:bg-white font-medium"
              >
                Back
              </button>
            )}
            {idx < steps.length - 1 ? (
              <button
                onClick={() => setIdx(i => Math.min(steps.length - 1, i + 1))}
                className="text-[12px] text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-md font-medium"
              >
                Next →
              </button>
            ) : (
              <button
                onClick={handleDone}
                className="text-[12px] text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-md font-medium"
              >
                Got it
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Pulse keyframes injected once. Tailwind doesn't ship a
          stroke-opacity pulse out of the box, so a tiny <style> tag
          here is cheaper than configuring the Tailwind config. */}
      <style>{`
        @keyframes mas-tutorial-pulse {
          0%   { stroke-opacity: 0.55; stroke-width: 2; }
          50%  { stroke-opacity: 1;    stroke-width: 3; }
          100% { stroke-opacity: 0.55; stroke-width: 2; }
        }
        .mas-tutorial-pulse {
          animation: mas-tutorial-pulse 1.6s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}
