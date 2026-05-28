import { useEffect, useRef, useState } from "react";
import type { AuthUser } from "../types";
import type { UseAuth } from "../hooks/useAuth";

/* ────────────────────────────────────────────────────────────────
 *  AuthPanel — pinned to the bottom of the left sidebar.
 *
 *  • When signed-out, shows a "Guest" row with a soft promo nudging
 *    the user to log in for persistent history / memory, plus a
 *    "Log in" button that opens a modal hosting Google's official
 *    Sign-In button (most reliable cross-browser).
 *  • When signed-in, shows the avatar + display name + a popover
 *    menu (Sign out, copy email).
 *  • When login is not configured server-side, the row stays as
 *    "Guest" and the button becomes a disabled hint instead of a
 *    broken CTA.
 *  ──────────────────────────────────────────────────────────────── */

interface Props {
  auth: UseAuth;
}

export function AuthPanel({ auth }: Props) {
  const { user, status, enabled, message, renderButton, signOut } = auth;

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showAcctMenu, setShowAcctMenu] = useState(false);
  const buttonHostRef = useRef<HTMLDivElement>(null);
  const acctMenuRef = useRef<HTMLDivElement>(null);

  // Render the official Google button into the modal once it opens
  // (the GSI library only renders when its target is in the DOM).
  useEffect(() => {
    if (!showLoginModal) return;
    const host = buttonHostRef.current;
    if (!host) return;
    let cancelled = false;
    void renderButton(host).then(ok => {
      if (cancelled || ok) return;
      // Renderer failed — surface a graceful fallback so the user
      // doesn't sit staring at an empty modal. The hook itself sets
      // a human-readable `message`; we just have to refresh.
    });
    return () => { cancelled = true; };
  }, [showLoginModal, renderButton]);

  // Close the modal automatically once the user is signed in.
  useEffect(() => {
    if (user) setShowLoginModal(false);
  }, [user]);

  // Close the account menu when the user clicks outside it.
  useEffect(() => {
    if (!showAcctMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (acctMenuRef.current && !acctMenuRef.current.contains(e.target as Node)) {
        setShowAcctMenu(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showAcctMenu]);

  const promoVisible = !user;
  const loginDisabled = !enabled;

  return (
    <div className="border-t border-gray-200 bg-white px-3 pt-3 pb-3 flex-none">
      {promoVisible && (
        <div className="mb-2 px-1.5 text-[10.5px] text-gray-500 leading-snug">
          {enabled ? (
            <>
              <span className="font-medium text-gray-700">Log in</span> to get a
              personalized experience — saved history, memory, and more.
            </>
          ) : (
            <span className="text-gray-400">{message ?? "Running as Guest."}</span>
          )}
        </div>
      )}

      {user ? (
        <SignedInRow
          user={user}
          showMenu={showAcctMenu}
          onToggleMenu={() => setShowAcctMenu(v => !v)}
          onSignOut={() => { setShowAcctMenu(false); signOut(); }}
          menuRef={acctMenuRef}
        />
      ) : (
        <GuestRow
          status={status}
          disabled={loginDisabled}
          onLogIn={() => setShowLoginModal(true)}
          disabledHint={message ?? undefined}
        />
      )}

      {showLoginModal && (
        <LoginModal
          buttonHostRef={buttonHostRef}
          message={message}
          onClose={() => setShowLoginModal(false)}
        />
      )}
    </div>
  );
}

/* ───────────────────────────────────────────── Signed-out row */

function GuestRow({
  status, disabled, onLogIn, disabledHint,
}: {
  status: "loading" | "ready" | "error";
  disabled: boolean;
  onLogIn: () => void;
  disabledHint?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Avatar name="Guest" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-gray-700 truncate">Guest</div>
        <div className="text-[10.5px] text-gray-400 truncate">Not signed in</div>
      </div>
      <button
        onClick={onLogIn}
        disabled={disabled || status === "loading"}
        title={disabled ? disabledHint || "Login is not configured" : "Sign in with Google"}
        className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors ${
          disabled || status === "loading"
            ? "border-gray-200 text-gray-300 cursor-not-allowed"
            : "border-blue-200 text-blue-700 bg-blue-50/40 hover:bg-blue-50"
        }`}
      >
        {status === "loading" ? "…" : "Log in"}
      </button>
    </div>
  );
}

/* ───────────────────────────────────────────── Signed-in row */

function SignedInRow({
  user, showMenu, onToggleMenu, onSignOut, menuRef,
}: {
  user: AuthUser;
  showMenu: boolean;
  onToggleMenu: () => void;
  onSignOut: () => void;
  menuRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={onToggleMenu}
        className="w-full flex items-center gap-2.5 px-1 py-1 rounded-md hover:bg-gray-100 transition-colors text-left"
        title={user.email || user.name}
      >
        <Avatar name={user.name} pictureUrl={user.picture} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-gray-800 truncate">{user.name}</div>
          {user.email && (
            <div className="text-[10.5px] text-gray-400 truncate">{user.email}</div>
          )}
        </div>
        <svg className="w-3 h-3 text-gray-400 flex-none" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path d="M9 6l6 6-6 6"/>
        </svg>
      </button>
      {showMenu && (
        <div className="absolute bottom-full left-0 right-0 mb-2 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden z-30">
          {user.email && (
            <button
              onClick={() => {
                navigator.clipboard?.writeText(user.email || "").catch(() => {});
                onToggleMenu();
              }}
              className="w-full text-left px-3 py-2 text-[12px] text-gray-700 hover:bg-gray-50"
            >
              Copy email
            </button>
          )}
          <button
            onClick={onSignOut}
            className="w-full text-left px-3 py-2 text-[12px] text-red-600 hover:bg-red-50 border-t border-gray-100"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────────────────────── Login modal */

function LoginModal({
  buttonHostRef, message, onClose,
}: {
  buttonHostRef: React.RefObject<HTMLDivElement>;
  message: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold text-gray-900">Sign in to MAS-Orchestra</div>
            <div className="text-[11px] text-gray-500">Continue with Google to unlock history & memory.</div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 -mr-1 -mt-1 p-1 rounded"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div className="px-5 py-6 flex flex-col items-center gap-3">
          {/* Google's official button lands here once the GIS library
              renders it. We give it a min height so the modal doesn't
              jump when the button materializes. */}
          <div ref={buttonHostRef} className="min-h-[44px] flex items-center justify-center" />
          {message && (
            <div className="text-[11px] text-red-600 text-center max-w-xs">{message}</div>
          )}
          <div className="text-[10.5px] text-gray-400 text-center max-w-xs leading-snug">
            We only store your name, email, and avatar so you can pick up
            where you left off. You can sign out anytime.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────── Avatar */

function Avatar({ name, pictureUrl }: { name: string; pictureUrl?: string }) {
  const [errored, setErrored] = useState(false);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? "")
    .join("") || "?";
  if (pictureUrl && !errored) {
    return (
      <img
        src={pictureUrl}
        alt={name}
        referrerPolicy="no-referrer"
        onError={() => setErrored(true)}
        className="w-7 h-7 rounded-full object-cover flex-none border border-gray-200"
      />
    );
  }
  // Deterministic-ish hue from the name so repeated visits land on the
  // same color. Keeps the Guest avatar consistently gray.
  const hue = name === "Guest"
    ? 0
    : Array.from(name).reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 5381) % 360;
  const bg = name === "Guest" ? "#e5e7eb" : `hsl(${hue}, 65%, 88%)`;
  const fg = name === "Guest" ? "#6b7280" : `hsl(${hue}, 50%, 30%)`;
  return (
    <div
      className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold flex-none border border-gray-200"
      style={{ background: bg, color: fg }}
    >
      {initials}
    </div>
  );
}
