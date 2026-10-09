import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      Alert.alert('Missing fields', 'Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn(cleanEmail, password);
      router.replace('/(tabs)/chat');
    } catch (e: any) {
      if (e instanceof ApiError && e.data?.code === 'EMAIL_NOT_VERIFIED') {
        // Correct password, but the email was never confirmed. A fresh code was just sent.
        router.push({ pathname: '/(auth)/verify', params: { email: e.data.email ?? cleanEmail } });
      } else {
        Alert.alert('Login failed', e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign in</Text>

      <TextInput
        placeholder="Email"
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        style={styles.input}
      />
      {/* Pressing "enter" on the keyboard submits the form */}
      <TextInput
        placeholder="Password"
        secureTextEntry
        autoComplete="current-password"
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={onSubmit}
        style={styles.input}
      />

      <Pressable onPress={onSubmit} disabled={busy} style={styles.button}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
      </Pressable>

      <Link href="/(auth)/signup" style={styles.link}>
        <Text>Don't have an account? Sign up</Text>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  title: { fontSize: 28, fontWeight: '600', marginBottom: 16 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16 },
  button: { backgroundColor: '#111', padding: 14, borderRadius: 8, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { marginTop: 16, alignSelf: 'center' },
});
