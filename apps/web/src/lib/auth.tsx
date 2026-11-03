import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { JwtPayload } from '@openestate/shared';
import { api, setAccessToken, refreshSession, onSessionEnded, getSessionEpoch } from './api';

interface AuthState {
  user: JwtPayload | null;
  isLoading: boolean;
  sessionEpoch: number;
}

interface AuthContextValue extends AuthState {
  /** Set when the server ended this session (see api.ts onSessionEnded); the
   * sign-in page shows it. Cleared once the user signs in again. */
  sessionEndedMessage: string | null;
  login: (
    email: string,
    password: string,
  ) => Promise<
    | { ok: true }
    | { ok: false; requiresTwoFactor: true; tempToken: string }
    | { ok: false; error: string }
  >;
  verifyTotp: (tempToken: string, code: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<void>;
  hasPermission: (perm: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function decodeJwt(token: string): JwtPayload | null {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => ({ user: null, isLoading: true, sessionEpoch: getSessionEpoch() }));
  const [sessionEndedMessage, setSessionEndedMessage] = useState<string | null>(null);

  useEffect(() => {
    onSessionEnded((message) => {
      setSessionEndedMessage(message);
      setState({ user: null, isLoading: false, sessionEpoch: getSessionEpoch() });
    });
    return () => onSessionEnded(null);
  }, []);

  useEffect(() => {
    if (state.user) setSessionEndedMessage(null);
  }, [state.user]);

  useEffect(() => {
    // refreshSession() (not a direct api('/auth/refresh') call) — shares
    // its in-flight request with api()'s own 401-retry refresh and with
    // any other concurrent caller, including a second invocation of this
    // same effect under React.StrictMode. Without that sharing, two
    // concurrent /auth/refresh calls race the single-use refresh-token
    // rotation: the loser 401s, and if it resolves second, its failure
    // overwrites the session the winner just established. The token refresh
    // updates credentials without starting a new privacy boundary.
    const epoch = getSessionEpoch();
    let active = true;
    refreshSession().then((accessToken) => {
      if (active && epoch === getSessionEpoch()) {
        setState({ user: accessToken ? decodeJwt(accessToken) : null, isLoading: false, sessionEpoch: epoch });
      }
    });
    return () => { active = false; };
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const epoch = getSessionEpoch();
      try {
        const res = await api<
          | { accessToken: string }
          | { requiresTwoFactor: true; tempToken: string }
        >('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });

        if (epoch !== getSessionEpoch()) throw new DOMException('Session changed', 'AbortError');
        if ('requiresTwoFactor' in res && res.requiresTwoFactor) {
          return { ok: false as const, requiresTwoFactor: true as const, tempToken: res.tempToken };
        }

        const { accessToken } = res as { accessToken: string };
        setAccessToken(accessToken);
        setState({ user: decodeJwt(accessToken), isLoading: false, sessionEpoch: getSessionEpoch() });
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    },
    [],
  );

  const verifyTotp = useCallback(async (tempToken: string, code: string) => {
    try {
      // The 2FA-pending login response never calls setAccessToken (there's
      // no real session yet) — this call needs the short-lived tempToken
      // as its own Bearer, not whatever (usually nothing) accessToken
      // currently holds. Mirrors apps/portal/src/lib/auth.tsx's same fix.
      setAccessToken(tempToken);
      const epoch = getSessionEpoch();
      const res = await api<{ accessToken: string }>('/auth/totp/verify', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      if (epoch !== getSessionEpoch()) throw new DOMException('Session changed', 'AbortError');
      setAccessToken(res.accessToken);
      setState({ user: decodeJwt(res.accessToken), isLoading: false, sessionEpoch: getSessionEpoch() });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  }, []);

  const logout = useCallback(async () => {
    const epoch = getSessionEpoch();
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    if (epoch !== getSessionEpoch()) return;
    setAccessToken(null);
    setState({ user: null, isLoading: false, sessionEpoch: getSessionEpoch() });
  }, []);

  const hasPermission = useCallback(
    (perm: string) => state.user?.permissions.includes(perm) ?? false,
    [state.user],
  );

  const value = useMemo(
    () => ({ ...state, sessionEndedMessage, login, verifyTotp, logout, hasPermission }),
    [state, sessionEndedMessage, login, verifyTotp, logout, hasPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
