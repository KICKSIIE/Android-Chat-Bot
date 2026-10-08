import { useAuth } from '@/lib/auth-context';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

const RESEND_SECONDS = 60;

export default function VerifyScreen() {
  const { verifyEmail, resendVerification } = useAuth();
  const router = useRouter();
  const { email } = useLocalSearchParams<{ email?: string }>();

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(RESEND_SECONDS); // a code was just sent

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (!email) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Nothing to verify</Text>
        <Link href="/(auth)/login" style={styles.link}>
          <Text>Back to sign in</Text>
        </Link>
      </View>
    );
  }

  async function onVerify() {
    if (code.length !== 6) {
      Alert.alert('Code', 'Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    try {
      await verifyEmail(email!, code);
      router.replace('/(tabs)/chat');
    } catch (e: any) {
      Alert.alert('Verification failed', e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    if (cooldown > 0) return;
    try {
      await resendVerification(email!);
      setCooldown(RESEND_SECONDS);
      Alert.alert('Code sent', `We sent a new code to ${email}.`);
    } catch (e: any) {
      Alert.alert('Could not resend', e.message);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Check your email</Text>
      <Text style={styles.body}>
        We sent a 6-digit code to {email}. It expires in 10 minutes.
      </Text>

      <TextInput
        placeholder="123456"
        value={code}
        onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={6}
        autoFocus
        style={[styles.input, styles.codeInput]}
      />

      <Pressable onPress={onVerify} disabled={busy} style={styles.button}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Verify</Text>}
      </Pressable>

      <Pressable onPress={onResend} disabled={cooldown > 0} style={styles.link}>
        <Text style={{ opacity: cooldown > 0 ? 0.5 : 1 }}>
          {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
        </Text>
      </Pressable>

      <Link href="/(auth)/login" style={styles.link}>
        <Text>Back to sign in</Text>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'center', gap: 12 },
  title: { fontSize: 28, fontWeight: '600', marginBottom: 4 },
  body: { fontSize: 15, opacity: 0.7, marginBottom: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 16 },
  codeInput: { fontSize: 28, letterSpacing: 8, textAlign: 'center' },
  button: { backgroundColor: '#111', padding: 14, borderRadius: 8, alignItems: 'center', marginTop: 8 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { marginTop: 12, alignSelf: 'center', padding: 4 },
});
