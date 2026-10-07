import * as SecureStore from 'expo-secure-store';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { apiFetch } from './api';

type User = { id: number; username: string; email: string; display_name?: string };

type AuthContextValue = {
  token: string | null;
  user: User | null;
  loading: boolean;
  signIn: (usernameOrEmail: string, password: string) => Promise<void>;
  signUp: (username: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session on app start
  useEffect(() => {
    (async () => {
      try {
        const savedToken = await SecureStore.getItemAsync('token');
        const savedUser = await SecureStore.getItemAsync('user');
        if (savedToken && savedUser) {
          setToken(savedToken);
          setUser(JSON.parse(savedUser));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function persist(newToken: string, newUser: User) {
    setToken(newToken);
    setUser(newUser);
    await SecureStore.setItemAsync('token', newToken);
    await SecureStore.setItemAsync('user', JSON.stringify(newUser));
  }

  async function signIn(usernameOrEmail: string, password: string) {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ usernameOrEmail, password }),
    });
    await persist(data.token, data.user);
  }

  async function signUp(username: string, email: string, password: string) {
    const data = await apiFetch('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    });
    await persist(data.token, data.user);
  }

  async function signOut() {
    setToken(null);
    setUser(null);
    await SecureStore.deleteItemAsync('token');
    await SecureStore.deleteItemAsync('user');
  }

  return (
    <AuthContext.Provider value={{ token, user, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}