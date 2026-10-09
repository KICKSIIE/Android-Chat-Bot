import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  TextInputProps,
  useColorScheme,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth-context';

// 'idle' = showing the first form, 'code' = waiting for the emailed code
type Step = 'idle' | 'code';

export default function SettingsScreen() {
  const {
    user,
    signOut,
    changeUsername,
    requestPasswordCode,
    changePassword,
    requestEmailCode,
    changeEmail,
  } = useAuth();
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  // Which action is running right now (null = none). Used to disable buttons and show a spinner.
  const [busy, setBusy] = useState<string | null>(null);

  // username
  const [username, setUsername] = useState(user?.username ?? '');

  // password
  const [pwStep, setPwStep] = useState<Step>('idle');
  const [pwCode, setPwCode] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // email
  const [emStep, setEmStep] = useState<Step>('idle');
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [emCode, setEmCode] = useState('');

  // Runs an action with a busy flag, and shows any error in an alert.
  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e: any) {
      Alert.alert('Something went wrong', e.message);
    } finally {
      setBusy(null);
    }
  }

  const saveUsername = () =>
    run('username', async () => {
      const name = username.trim();
      if (name.length < 2 || name.length > 30) throw new Error('Username must be 2 to 30 characters.');
      await changeUsername(name);
      Alert.alert('Saved', 'Your username was updated.');
    });

  // Password step 1: email a code to the current address
  const sendPasswordCode = () =>
    run('pw-send', async () => {
      await requestPasswordCode();
      setPwStep('code');
      Alert.alert('Code sent', `We emailed a 6-digit code to ${user?.email}.`);
    });

  // Password step 2: check the code and set the new password
  const confirmPassword = () =>
    run('pw-confirm', async () => {
      if (pwCode.length !== 6) throw new Error('Enter the 6-digit code.');
      if (newPassword.length < 8) throw new Error('New password must be at least 8 characters.');
      await changePassword(pwCode, newPassword);
      // Reset the form
      setPwStep('idle');
      setPwCode('');
      setNewPassword('');
      Alert.alert('Password changed', 'Other devices have been signed out.');
    });

  // Email step 1: needs the current password, then emails a code to the NEW address
  const sendEmailCode = () =>
    run('em-send', async () => {
      if (!newEmail.trim()) throw new Error('Enter the new email address.');
      if (!currentPassword) throw new Error('Enter your current password.');
      await requestEmailCode(newEmail.trim(), currentPassword);
      setEmStep('code');
      Alert.alert('Code sent', `We emailed a 6-digit code to ${newEmail.trim().toLowerCase()}.`);
    });

  // Email step 2: check the code and switch the account email
  const confirmEmail = () =>
    run('em-confirm', async () => {
      if (emCode.length !== 6) throw new Error('Enter the 6-digit code.');
      await changeEmail(emCode);
      // Reset the form
      setEmStep('idle');
      setNewEmail('');
      setCurrentPassword('');
      setEmCode('');
      Alert.alert('Email changed', 'Your account email was updated.');
    });

  // Disable every button while any action is running
  const disabled = busy !== null;

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <ThemedText type="small" style={styles.heading}>
            Signed in as {user?.email}
          </ThemedText>

          {/* Username */}
          <ThemedText type="small" style={styles.sectionTitle}>Username</ThemedText>
          <Field colors={colors} value={username} onChangeText={setUsername} placeholder="Username" autoCapitalize="none" />
          <Btn label="Save username" onPress={saveUsername} disabled={disabled} busy={busy === 'username'} />

          {/* Password */}
          <ThemedText type="small" style={styles.sectionTitle}>Password</ThemedText>
          {pwStep === 'idle' ? (
            <Btn label="Email me a code" onPress={sendPasswordCode} disabled={disabled} busy={busy === 'pw-send'} />
          ) : (
            <>
              {/* Digits only, max 6 */}
              <Field
                colors={colors}
                value={pwCode}
                onChangeText={(t) => setPwCode(t.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit code"
                keyboardType="number-pad"
                maxLength={6}
              />
              <Field colors={colors} value={newPassword} onChangeText={setNewPassword} placeholder="New password (min 8 chars)" secureTextEntry autoComplete="new-password" />
              <Btn label="Change password" onPress={confirmPassword} disabled={disabled} busy={busy === 'pw-confirm'} />
              <Btn label="Cancel" secondary onPress={() => setPwStep('idle')} disabled={disabled} />
            </>
          )}

          {/* Email */}
          <ThemedText type="small" style={styles.sectionTitle}>Email</ThemedText>
          {emStep === 'idle' ? (
            <>
              <Field colors={colors} value={newEmail} onChangeText={setNewEmail} placeholder="New email" autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
              <Field colors={colors} value={currentPassword} onChangeText={setCurrentPassword} placeholder="Current password" secureTextEntry />
              <Btn label="Send code to new email" onPress={sendEmailCode} disabled={disabled} busy={busy === 'em-send'} />
            </>
          ) : (
            <>
              <ThemedText type="small">Enter the code sent to {newEmail.trim().toLowerCase()}.</ThemedText>
              <Field
                colors={colors}
                value={emCode}
                onChangeText={(t) => setEmCode(t.replace(/\D/g, '').slice(0, 6))}
                placeholder="6-digit code"
                keyboardType="number-pad"
                maxLength={6}
              />
              <Btn label="Change email" onPress={confirmEmail} disabled={disabled} busy={busy === 'em-confirm'} />
              <Btn label="Cancel" secondary onPress={() => setEmStep('idle')} disabled={disabled} />
            </>
          )}

          <Btn label="Sign out" secondary onPress={signOut} disabled={disabled} />
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

// Text input with the app's border and theme text color
function Field({ colors, ...props }: TextInputProps & { colors: { text: string } }) {
  return <TextInput placeholderTextColor="#888" {...props} style={[styles.input, { color: colors.text }]} />;
}

// Button: dark by default, outlined when `secondary`. Shows a spinner while `busy`.
function Btn({
  label,
  onPress,
  disabled,
  busy,
  secondary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      // Fade the other buttons while one is busy, but keep the busy one fully visible
      style={[styles.button, secondary ? styles.buttonSecondary : styles.buttonPrimary, disabled && !busy && { opacity: 0.5 }]}>
      {busy ? (
        <ActivityIndicator color={secondary ? undefined : '#fff'} />
      ) : (
        <ThemedText type="small" style={secondary ? undefined : styles.buttonPrimaryText}>
          {label}
        </ThemedText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1, alignSelf: 'center', width: '100%', maxWidth: MaxContentWidth },
  content: { padding: Spacing.three, gap: Spacing.two, paddingBottom: Spacing.four * 2 },
  heading: { marginBottom: Spacing.two },
  sectionTitle: { marginTop: Spacing.three, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: '#8885',
    borderRadius: 8,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  button: { paddingVertical: Spacing.three, borderRadius: 8, alignItems: 'center' },
  buttonPrimary: { backgroundColor: '#111' },
  buttonPrimaryText: { color: '#fff', fontWeight: '600' },
  buttonSecondary: { borderWidth: 1, borderColor: '#8885' },
});
