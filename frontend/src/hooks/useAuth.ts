import { useCallback, useEffect, useRef, useState } from "react";
import type { AuthUser } from "../types";

/* ────────────────────────────────────────────────────────────────
 * useAuth — minimal Google Sign-In integration for the left sidebar.
 *
 * Flow:
 *  1. On mount we fetch /auth/config to learn whether the backend
 *     has a GOOGLE_CLIENT_ID configured. If not, login is "disabled"
 *     and the UI shows a friendly hint instead of a broken button.
 *  2. When the user clicks "Continue with Google" we call
 *     google.accounts.id.initialize + renderButton (One Tap style)
 *     against a container the AuthPanel passes in via promptLogin().
 *  3. Google's callback hands us a JWT; we POST it to /auth/google
 *     where google-auth verifies signature + audience + expiry and
 *     returns the user profile.
 *  4. Profile lands in state + localStorage so the user stays signed
 *     in across reloads. We don't store the token (it expires anyway).
 *
 * The hook is intentionally renderless — the AuthPanel owns the UX.
 * ────────────────────────────────────────────────────────────────── */

const STORAGE_KEY = "masOrchestraUser:v1";

/** Read the currently signed-in user from localStorage from non-React
 *  call sites (other hooks, fetch callbacks, components without auth
 *  context). Returns ``null`` when the user is a guest or the
 *  storage is unavailable. Cheap — a single JSON.parse on a small
 *  blob; safe to call inside event handlers without memoization. */
export function readStoredAuthUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    if (parsed && typeof parsed.sub === "string" && typeof parsed.name === "string") {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

interface AuthConfig {
  google_client_id: string | null;
  enabled: boolean;
}

// Minimal slice of the Google Identity Services surface we use. Kept
// here instead of @types/google.accounts to avoid a hard dep — the
// script tag is loaded directly in index.html.
interface GoogleAccountsId {
  initialize(args: {
    client_id: string;
    callback: (resp: { credential?: string }) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    use_fedcm_for_prompt?: boolean;
  }): void;
  renderButton(
    container: HTMLElement,
    options: {
      theme?: "outline" | "filled_blue" | "filled_black";
      size?: "small" | "medium" | "large";
      type?: "standard" | "icon";
      text?: "signin_with" | "signup_with" | "continue_with" | "signin";
      shape?: "rectangular" | "pill" | "circle" | "square";
      logo_alignment?: "left" | "center";
      width?: number | string;
    },
  ): void;
  prompt(): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleAccountsId } };
  }
}

// Module-internal alias kept for readability at the call site below.
const loadUserFromStorage = readStoredAuthUser;

async function waitForGoogle(timeoutMs = 8000): Promise<GoogleAccountsId | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const gid = window.google?.accounts?.id;
    if (gid) return gid;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

export interface UseAuth {
  user: AuthUser | null;
  /** "loading" while we fetch /auth/config; "ready" once we know
   *  whether login is enabled; "error" if the config fetch failed. */
  status: "loading" | "ready" | "error";
  /** True only when both the backend has a client ID configured AND
   *  the GIS script has actually loaded. The AuthPanel keys its CTA
   *  off this so we never offer a broken "Log in" button. */
  enabled: boolean;
  /** Set when login is disabled or a verification call fails. */
  message: string | null;
  /** Render the official Google button into the supplied container.
   *  Returns true on success, false if Google's library isn't loaded
   *  yet or login is disabled. */
  renderButton: (container: HTMLElement) => Promise<boolean>;
  /** Clear local state. Doesn't revoke the Google grant — the user
   *  can do that from their Google account settings. */
  signOut: () => void;
}

export function useAuth(): UseAuth {
  const [user, setUser] = useState<AuthUser | null>(loadUserFromStorage);
  const [status, setStatus] = useState<UseAuth["status"]>("loading");
  const [clientId, setClientId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const initializedRef = useRef(false);

  // Persist user → localStorage on every change so the auth survives
  // a reload. Clearing the user also clears storage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (user) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Quota / private-mode → silent.
    }
  }, [user]);

  // Pull config from backend once so we know whether to even attempt
  // to wire up Google. AbortController guards a fast-unmount race.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/auth/config", { signal: ctrl.signal })
      .then(r => r.json() as Promise<AuthConfig>)
      .then(cfg => {
        setClientId(cfg.google_client_id);
        setStatus("ready");
        if (!cfg.enabled) {
          setMessage("Admin hasn't enabled Google login yet — running as Guest.");
        }
      })
      .catch(err => {
        if ((err as Error).name === "AbortError") return;
        setStatus("error");
        setMessage("Could not reach the auth service — running as Guest.");
      });
    return () => ctrl.abort();
  }, []);

  // Verify a Google ID token by round-tripping through the backend.
  const verifyToken = useCallback(async (credential: string): Promise<void> => {
    try {
      const res = await fetch("/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id_token: credential }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => `HTTP ${res.status}`);
        setMessage(`Login failed: ${detail}`);
        return;
      }
      const profile = (await res.json()) as AuthUser;
      setUser(profile);
      setMessage(null);
    } catch (err) {
      setMessage(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const ensureInitialized = useCallback(async (): Promise<GoogleAccountsId | null> => {
    if (!clientId) return null;
    const gid = await waitForGoogle();
    if (!gid) {
      setMessage("Google sign-in script failed to load. Check your network and reload.");
      return null;
    }
    if (!initializedRef.current) {
      gid.initialize({
        client_id: clientId,
        callback: (resp) => {
          if (resp.credential) {
            void verifyToken(resp.credential);
          }
        },
        auto_select: false,
        cancel_on_tap_outside: true,
        use_fedcm_for_prompt: true,
      });
      initializedRef.current = true;
    }
    return gid;
  }, [clientId, verifyToken]);

  const renderButton = useCallback(async (container: HTMLElement) => {
    const gid = await ensureInitialized();
    if (!gid) return false;
    try {
      container.replaceChildren();
      gid.renderButton(container, {
        theme: "outline",
        size: "large",
        type: "standard",
        text: "continue_with",
        shape: "pill",
        logo_alignment: "left",
        width: 240,
      });
      return true;
    } catch (err) {
      setMessage(`Could not render Google button: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }, [ensureInitialized]);

  const signOut = useCallback(() => {
    setUser(null);
    setMessage(null);
    try {
      window.google?.accounts?.id?.disableAutoSelect?.();
    } catch {
      // Best-effort — Google may not be initialized yet.
    }
  }, []);

  const enabled = status === "ready" && !!clientId;

  return { user, status, enabled, message, renderButton, signOut };
}
