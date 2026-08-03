import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { DEFAULT_API_BASE_URL } from '../../shared/api/client';
import { findTier, formatUsd } from '../../shared/pricing';
import { colors, radius, space } from '../../shared/theme';
import ThemedButton from './ThemedButton';

// Same rationale as ui/desktop/src/pages/Checkout.tsx: PayPal's documented
// sandbox demo client-id, usable without a real PayPal developer account.
// Swap for a real one once credentials are chosen; server-side capture is
// still a deliberate stub either way (geocoding-server/src/billing.js).
const PAYPAL_CLIENT_ID = 'test';

type Props = {
  addressCount: number;
  onBack: () => void;
};

type Status = 'idle' | 'error' | 'success';

export default function CheckoutSection({ addressCount, onBack }: Props) {
  const tier = findTier(addressCount);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const containerRef = useRef<View>(null);
  const emailRef = useRef(email);
  emailRef.current = email;

  useEffect(() => {
    if (!tier) return;
    const container = containerRef.current as unknown as HTMLElement | null;
    if (!container) return;

    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=USD`;
    script.onload = () => {
      const paypal = (window as any).paypal;
      paypal
        .Buttons({
          createOrder: (_data: unknown, actions: any) =>
            actions.order.create({
              purchase_units: [{ amount: { value: (tier.priceCents / 100).toFixed(2) } }],
            }),
          onApprove: async (_data: unknown, actions: any) => {
            const trimmedEmail = emailRef.current.trim();
            if (!trimmedEmail) {
              setStatus('error');
              setMessage('Enter your account email before paying.');
              return;
            }
            try {
              const order = await actions.order.capture();
              const response = await fetch(`${DEFAULT_API_BASE_URL}/billing/purchase`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  email: trimmedEmail,
                  addressCount: tier.addressCount,
                  orderId: order.id,
                }),
              });
              const body = await response.json();
              if (!response.ok) {
                setStatus('error');
                setMessage(body.error ?? 'Purchase failed.');
                return;
              }
              setStatus('success');
              setMessage(
                `Done (test mode, no real charge) — ${body.tier.toLocaleString()} total monthly addresses now available for ${trimmedEmail}.`
              );
            } catch (err) {
              setStatus('error');
              setMessage(err instanceof Error ? err.message : 'Purchase failed.');
            }
          },
          onError: (err: unknown) => {
            setStatus('error');
            setMessage(err instanceof Error ? err.message : 'PayPal reported an error.');
          },
        })
        .render(container);
    };
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    };
  }, [tier]);

  if (!tier) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Checkout</Text>
      <Text style={styles.subtitle}>
        {tier.label} for {formatUsd(tier.priceCents)}.
      </Text>

      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          Test mode: PayPal's sandbox approval flow runs for real, but the server-side charge is a
          deliberate stub — no money moves. Your account's quota is topped up for real, though.
        </Text>
      </View>

      <Text style={styles.label}>Account email</Text>
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

      <View ref={containerRef} style={styles.paypalContainer} />

      {status === 'success' && (
        <Text style={[styles.message, { color: colors.accent }]}>{message}</Text>
      )}
      {status === 'error' && <Text style={[styles.message, styles.errorText]}>{message}</Text>}

      <View style={styles.spacing}>
        <ThemedButton title="Back to pricing" onPress={onBack} variant="ghost" />
      </View>
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
  paypalContainer: {
    marginBottom: space[4],
  },
  message: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    marginBottom: space[4],
  },
  errorText: {
    color: colors.errorText,
  },
  spacing: {
    marginTop: space[2],
  },
});
