import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Button,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

// Points at the geocoding-server Express API (C:\software\geocoding-server).
// On a physical device/simulator, "localhost" means the device itself, so
// swap this for your dev machine's LAN IP (e.g. http://192.168.1.23:3001).
const QUOTA_API_URL = 'http://localhost:3001/quota';

type QuotaResponse = {
  email: string;
  tier: number;
  usedThisPeriod: number;
  remaining: number;
  periodStart: string;
};

type QuotaErrorResponse = {
  error: string;
};

// There's no signup/login/session anywhere in this app -- quota is looked
// up by email per request (see users.js), not by a logged-in account, so
// this screen has to ask for the email it's checking rather than assume one.
export default function PlanQuotaForm() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
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
      const response = await fetch(`${QUOTA_API_URL}?email=${encodeURIComponent(trimmedEmail)}`);
      const body = (await response.json()) as QuotaResponse | QuotaErrorResponse;

      if (!response.ok || 'error' in body) {
        const message = 'error' in body ? body.error : 'Checking quota failed.';
        throw new Error(message);
      }

      setQuota(body);
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
      <Text style={styles.label}>Account email</Text>
      <TextInput
        style={styles.input}
        placeholder="e.g. alice@example.com"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        editable={!loading}
        returnKeyType="search"
        onSubmitEditing={handleCheckQuota}
      />

      <Button title="Check Quota" onPress={handleCheckQuota} disabled={loading} />

      {loading && <ActivityIndicator style={styles.spacing} size="small" />}

      {!loading && quota && (
        <View style={styles.spacing}>
          <Text style={styles.resultLabel}>
            {quota.usedThisPeriod} / {quota.tier} used this period
          </Text>
          <View style={styles.usageBarTrack}>
            <View style={[styles.usageBarFill, { width: `${usedFraction * 100}%` }]} />
          </View>
          <Text style={styles.spacing}>{quota.remaining} addresses remaining</Text>
          <Text>Period started {quota.periodStart} — resets monthly on the 1st.</Text>
          <Text style={[styles.spacing, styles.noteText]}>
            Quota is tracked per account email; there's no self-service upgrade yet — contact
            your administrator to request a higher tier.
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
    padding: 16,
  },
  label: {
    fontSize: 14,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
  },
  spacing: {
    marginTop: 16,
  },
  resultLabel: {
    fontWeight: '600',
    marginBottom: 8,
  },
  usageBarTrack: {
    height: 10,
    borderRadius: 5,
    backgroundColor: '#eee',
    overflow: 'hidden',
  },
  usageBarFill: {
    height: '100%',
    backgroundColor: '#2196F3',
  },
  noteText: {
    color: '#666',
    fontStyle: 'italic',
  },
  errorText: {
    color: '#c0392b',
  },
});
