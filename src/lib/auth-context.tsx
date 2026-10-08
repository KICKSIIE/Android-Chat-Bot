import * as SecureStore from 'expo-secure-store';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, setUnauthorizedHandler } from './api';

export type User = { id: number; username: string; email: string; display_name?: string };

type AuthContextValue = {
  token: string | null;
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (username: string, email: string, password: string) => Promise<void>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  requestPasswordCode: () => Promise<void>;
  changePassword: (code: string, newPassword: string) => Promise<void>;
  requestEmailCode: (newEmail: string, currentPassword: string) => Promise<void>;
  changeEmail: (code: string) => Promise<void>;
  changeUsername: (username: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const tokenRef = useRef<string | null>(null);

  const actions = useMemo(() => {
    async function saveUser(u: User) {
      setUser(u);
      await SecureStore.setItemAsync('user', JSON.stringify(u));
    }

    async function persist(newToken: string, newUser: User) {
      tokenRef.current = newToken;
      setToken(newToken);
      await SecureStore.setItemAsync('token', newToken);
      await saveUser(newUser);
    }

    const post = (path: string, body: object) =>
      apiFetch(path, { method: 'POST', body: JSON.stringify(body) }, tokenRef.current);

    return {
      async signIn(email: string, password: string) {
        const data = await apiFetch('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        await persist(data.token, data.user);
      },
      async signUp(username: string, email: string, password: string) {
        // No token yet: the account must be verified first.
        await apiFetch('/api/auth/signup', {
          method: 'POST',
          body: JSON.stringify({ username, email, password }),
        });
      },
      async verifyEmail(email: string, code: string) {
        const data = await apiFetch('/api/auth/verify-email', {
          method: 'POST',
          body: JSON.stringify({ email, code }),
        });
        await persist(data.token, data.user);
      },
      async resendVerification(email: string) {
        await apiFetch('/api/auth/resend', { method: 'POST', body: JSON.stringify({ email }) });
      },
      async requestPasswordCode() {
        await post('/api/account/request-code', { purpose: 'change_password' });
      },
      async changePassword(code: string, newPassword: string) {
        const data = await post('/api/account/change-password', { code, newPassword });
        await persist(data.token, data.user);
      },
      async requestEmailCode(newEmail: string, currentPassword: string) {
        await post('/api/account/request-code', { purpose: 'change_email', newEmail, currentPassword });
      },
      async changeEmail(code: string) {
        const data = await post('/api/account/change-email', { code });
        await persist(data.token, data.user);
      },
      async changeUsername(username: string) {
        const data = await apiFetch(
          '/api/account/username',
          { method: 'PATCH', body: JSON.stringify({ username }) },
          tokenRef.current,
        );
        await saveUser(data.user);
      },
      async signOut() {
        tokenRef.current = null;
        setToken(null);
        setUser(null);
        await Promise.all([SecureStore.deleteItemAsync('token'), SecureStore.deleteItemAsync('user')]);
      },
      saveUser,
      persist,
    };
  }, []);

  // Restore session on app start, then quietly refresh the user from the server.
  useEffect(() => {
    (async () => {
      try {
        const savedToken = await SecureStore.getItemAsync('token');
        const savedUser = await SecureStore.getItemAsync('user');
        if (savedToken && savedUser) {
          tokenRef.current = savedToken;
          setToken(savedToken);
          setUser(JSON.parse(savedUser));
          apiFetch('/api/me', {}, savedToken)
            .then((d) => actions.saveUser(d.user))
            .catch(() => {}); // a 401 signs out via the handler below
        }
      } catch {
        // corrupted storage: fall through to the sign-in screen
      } finally {
        setLoading(false);
      }
    })();
  }, [actions]);

  // Any 401 on an authenticated request (expired, or password changed elsewhere) signs out.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      actions.signOut();
    });
    return () => setUnauthorizedHandler(null);
  }, [actions]);

  const value = useMemo<AuthContextValue>(
    () => ({
      token,
      user,
      loading,
      signIn: actions.signIn,
      signUp: actions.signUp,
      verifyEmail: actions.verifyEmail,
      resendVerification: actions.resendVerification,
      requestPasswordCode: actions.requestPasswordCode,
      changePassword: actions.changePassword,
      requestEmailCode: actions.requestEmailCode,
      changeEmail: actions.changeEmail,
      changeUsername: actions.changeUsername,
      signOut: actions.signOut,
    }),
    [token, user, loading, actions],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
