import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { registerRoadAlerts } from '../../shared/api/client';
import { colors, radius, space } from '../../shared/theme';
import ThemedButton from './ThemedButton';
import { setStoredAccount } from './roadAlertsStorage';

type Props = {
  onRegistered: (account: { email: string; serviceKey: string }) => void;
  // Shown after a stale/invalid stored account was cleared -- distinct
  // from a plain first-time registration, so the copy can say why the
  // user is seeing this form again instead of the app just working.
  reason?: string | null;
};

export default function RoadAlertsRegistration({ onRegistered, reason }: Props) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRegister = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter an email address.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await registerRoadAlerts(trimmed);
      await setStoredAccount({ email: result.email, serviceKey: result.serviceKey });
      onRegistered({ email: result.email, serviceKey: result.serviceKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setLoading(false);
    }
  }, [email, onRegistered]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Road alerts -- register to get started</Text>
      <Text style={styles.subtitle}>Free while we're testing this feature -- no payment required.</Text>

      {reason && (
        <View style={styles.noteCard}>
          <Text style={styles.noteText}>{reason}</Text>
        </View>
      )}

      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          Just an email -- no password. You'll get a service key back (also emailed to you); this
          device remembers it so you won't need to re-enter it every drive. Registering again later
          with the same email re-sends your existing key, so it's safe to use as a recovery step if
          you ever need it.
        </Text>
      </View>

      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        placeholder="you@example.com"
        placeholderTextColor={colors.neutral500}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        editable={!loading}
        onSubmitEditing={handleRegister}
      />

      {error && <Text style={[styles.message, styles.errorText]}>{error}</Text>}

      <ThemedButton title="Register" onPress={handleRegister} loading={loading} block />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    padding: space[4],
  },
  title: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 26,
    color: colors.text,
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    opacity: 0.7,
    marginBottom: space[4],
  },
  noteCard: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: space[3],
    marginBottom: space[4],
  },
  noteText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    opacity: 0.8,
    lineHeight: 19,
  },
  label: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
    opacity: 0.7,
    marginBottom: 5,
  },
  input: {
    fontFamily: 'Lora_400Regular',
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: space[4],
    color: colors.text,
  },
  message: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    marginBottom: space[3],
  },
  errorText: {
    color: colors.errorText,
  },
});
