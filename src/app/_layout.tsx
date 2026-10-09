import { AuthProvider, useAuth } from '@/lib/auth-context';
import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';

// Decides which screens the user can see, based on whether they are signed in
function RootNavigator() {
  const { token, loading } = useAuth();
  const segments = useSegments(); // where the user currently is, e.g. ['(auth)', 'login']
  const router = useRouter();

  useEffect(() => {
    if (loading) return; // still checking for a saved login
    const inAuthGroup = segments[0] === '(auth)';

    if (!token && !inAuthGroup) {
      // Signed out but not on a login screen: go to sign in
      router.replace('/(auth)/login');
    } else if (token && inAuthGroup) {
      // Signed in but still on a login screen: go to the app
      router.replace('/(tabs)/chat');
    }
  }, [token, loading, segments]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

// App entry: gives every screen access to the login state
export default function RootLayout() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
