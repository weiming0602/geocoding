import React, { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';

import { getQuota } from '../../shared/api/client';
import type { QuotaStatus } from '../../shared/api/types';
import { colors, radius, space } from '../../shared/theme';
import ThemedButton from './ThemedButton';

// There's no signup/login/session anywhere in this app -- quota is looked
// up by email per request (see users.js), not by a logged-in account, so
// this screen has to ask for the email it's checking rather than assume one.
export default function PlanQuotaForm() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCheckQuota = useCallback(async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setQuota(null);
      setError('Enter an email address first.');
      return;
    }

    setLoading(true);
    setError(null);
    setQuota(null);

    try {
      const result = await getQuota(trimmedEmail);
      setQuota(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Checking quota failed.';
      setError(message);
      Alert.alert('Quota lookup error', message);
    } finally {
      setLoading(false);
    }
  }, [email]);

  const usedFraction = quota ? Math.min(1, quota.usedThisPeriod / quota.tier) : 0;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Plan &amp; quota</Text>
      <Text style={styles.subtitle}>Usage resets on the 1st of each calendar month.</Text>

      <Text style={styles.label}>Account email</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. alice@example.com"
        placeholderTextColor={colors.neutral500}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        editable={!loading}
        returnKeyType="search"
        onSubmitEditing={handleCheckQuota}
      />

      <ThemedButton title="Check Quota" onPress={handleCheckQuota} loading={loading} block />

      {!loading && quota && (
        <View style={[styles.card, styles.spacing]}>
          <Text style={styles.cardKicker}>Current period</Text>
          <Text style={styles.cardTitle}>
            {quota.usedThisPeriod.toLocaleString()} / {quota.tier.toLocaleString()} requests
          </Text>
          <View style={styles.usageBarTrack}>
            <View style={[styles.usageBarFill, { width: `${usedFraction * 100}%` }]} />
          </View>
          <Text style={styles.cardMeta}>Resets {quota.periodStart}</Text>
          <Text style={[styles.spacing, styles.noteText]}>
            There's no self-service upgrade yet — contact your administrator to request a higher
            tier.
          </Text>
        </View>
      )}

      {!loading && error && <Text style={[styles.spacing, styles.errorText]}>{error}</Text>}
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
    fontSize: 30,
    color: colors.text,
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    opacity: 0.7,
    marginBottom: space[6],
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
  spacing: {
    marginTop: space[4],
  },
  card: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    padding: space[3],
  },
  cardKicker: {
    fontFamily: 'Lora_400Regular',
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.accent,
    marginBottom: 4,
  },
  cardTitle: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 17,
    color: colors.text,
    marginBottom: space[2],
  },
  cardMeta: {
    fontFamily: 'Lora_400Regular',
    fontSize: 11,
    color: colors.text,
    opacity: 0.5,
  },
  usageBarTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.divider,
    overflow: 'hidden',
    marginBottom: space[2],
  },
  usageBarFill: {
    height: '100%',
    backgroundColor: colors.accent500,
  },
  noteText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
    opacity: 0.65,
  },
  errorText: {
    fontFamily: 'Lora_400Regular',
    color: colors.errorText,
  },
});
