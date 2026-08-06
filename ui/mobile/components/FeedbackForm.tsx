import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { DEFAULT_API_BASE_URL } from '../../shared/api/client';
import { colors, radius, space } from '../../shared/theme';
import ThemedButton from './ThemedButton';

type Status = 'idle' | 'submitting' | 'success' | 'error';

// POST /feedback -- a one-way comment/question box. There's no public
// display or in-app reply: the site owner gets notified by email and
// replies directly, outside the app, to whatever email is left here.
export default function FeedbackForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!message.trim()) {
      setStatus('error');
      setError('Enter a comment or question first.');
      return;
    }
    setStatus('submitting');
    setError('');
    try {
      const response = await fetch(`${DEFAULT_API_BASE_URL}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || undefined,
          email: email.trim() || undefined,
          message: message.trim(),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setStatus('error');
        setError(body.error ?? 'Something went wrong.');
        return;
      }
      setStatus('success');
      setName('');
      setEmail('');
      setMessage('');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Comments or questions</Text>
      <Text style={styles.subtitle}>
        Leave an email if you'd like a reply — we'll write back directly.
      </Text>

      <Text style={styles.label}>Name (optional)</Text>
      <TextInput
        style={styles.input}
        placeholder="Just a first name is fine"
        placeholderTextColor={colors.neutral500}
        value={name}
        onChangeText={setName}
      />

      <Text style={styles.label}>Email (optional)</Text>
      <TextInput
        style={styles.input}
        placeholder="you@company.com"
        placeholderTextColor={colors.neutral500}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
      />

      <Text style={styles.label}>Comment or question</Text>
      <TextInput
        style={[styles.input, styles.messageInput]}
        value={message}
        onChangeText={setMessage}
        multiline
        numberOfLines={4}
      />

      <ThemedButton
        title="Send"
        onPress={handleSubmit}
        loading={status === 'submitting'}
      />

      {status === 'success' && <Text style={[styles.message, { color: colors.accent }]}>Thanks — got it.</Text>}
      {status === 'error' && <Text style={[styles.message, styles.errorText]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    padding: space[4],
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  title: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 20,
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
  messageInput: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  message: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    marginTop: space[3],
  },
  errorText: {
    color: colors.errorText,
  },
});
