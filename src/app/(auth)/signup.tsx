import { useAuth } from '@/lib/auth-context';
import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export default function SignupScreen() {
  const { signUp } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    if (!username || !email || !password) {
      Alert.alert('Missing fields', 'Fill in all fields.');
      return;
    }
    if (password.length < 8) {
      Alert.alert('Weak password', 'Use at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await signUp(username, email, password);
      router.replace('/(tabs)/chat');
    } catch (e: any) {
      Alert.alert('Signup failed', e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Create account</Text>

      <TextInput placeholder="Username" autoCapitalize="none" value={username} onChangeText={setUsername} style={styles.input} />
      <TextInput placeholder="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} style={styles.input} />
      <TextInput placeholder="Password (min 8 chars)" secureTextEntry value={password} onChangeText={setPassword} style={styles.input} />

      <Pressable onPress={onSubmit} disabled={busy} style={styles.button}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign up</Text>}
      </Pressable>

      <Link href="/(auth)/login" style={styles.link}>
        <Text>Already have an account? Sign in</Text>
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