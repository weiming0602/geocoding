import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { DEFAULT_API_BASE_URL } from '../../shared/api/client';
import { findTier, formatUsd } from '../../shared/pricing';
import { colors, radius, space } from '../../shared/theme';
import ThemedButton from './ThemedButton';

// Same rationale as ui/desktop/src/pages/Checkout.tsx: the app's PayPal
// Client ID (public by design). Defaults to the sandbox Client ID so a
// fresh build never accidentally takes real money; set
// EXPO_PUBLIC_PAYPAL_CLIENT_ID (Expo inlines EXPO_PUBLIC_* at build time)
// to a live app's Client ID to go live. The Client Secret only ever
// lives server-side, in geocoding-server's .env.
const PAYPAL_CLIENT_ID =
  process.env.EXPO_PUBLIC_PAYPAL_CLIENT_ID ||
  'AUDJ7TGH_-VU3s7R4O3XBDn80KhOZWab-25TanFeikBPx4hYA8aT_F9tqgaiwHmYwSRoJMxY9ODEiT3P';

// Purely cosmetic (which note/wording to show) -- the server is what
// actually decides sandbox vs. live. Keep this in sync with that so the
// checkout screen never tells a real paying customer "no real money
// moves".
const PAYPAL_ENV = process.env.EXPO_PUBLIC_PAYPAL_ENV === 'live' ? 'live' : 'sandbox';

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
  const [serviceKey, setServiceKey] = useState('');
  const [serviceKeyEmailed, setServiceKeyEmailed] = useState(false);
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
          onApprove: async (data: { orderID: string }) => {
            const trimmedEmail = emailRef.current.trim();
            if (!trimmedEmail) {
              setStatus('error');
              setMessage('Enter your account email before paying.');
              return;
            }
            try {
              // Deliberately not calling actions.order.capture() here --
              // the server captures it (with the Client Secret), which is
              // what actually confirms the money moved instead of just
              // trusting the client's word for it.
              const response = await fetch(`${DEFAULT_API_BASE_URL}/billing/purchase`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  email: trimmedEmail,
                  addressCount: tier.addressCount,
                  orderId: data.orderID,
                }),
              });
              const body = await response.json();
              if (!response.ok) {
                setStatus('error');
                setMessage(body.error ?? 'Purchase failed.');
                return;
              }
              setStatus('success');
              setServiceKey(body.serviceKey ?? '');
              setServiceKeyEmailed(Boolean(body.serviceKeyEmailed));
              setMessage(
                body.stubbed
                  ? `Done (test mode, no real charge) — ${body.tier.toLocaleString()} total monthly addresses now available for ${trimmedEmail}.`
                  : `Payment captured${PAYPAL_ENV === 'sandbox' ? ' (sandbox)' : ''} — ${body.tier.toLocaleString()} total monthly addresses now available for ${trimmedEmail}.`
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
          {PAYPAL_ENV === 'live'
            ? "This is a real charge. Completing checkout charges your PayPal account or card for the amount above — captured server-side once you approve it."
            : "Sandbox mode: this runs PayPal's real sandbox order flow, captured server-side — no real money moves, but the transaction itself is real (it'll show up in PayPal's sandbox dashboard). Your account's quota is topped up for real either way."}
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
        <>
          <Text style={[styles.message, { color: colors.accent }]}>{message}</Text>
          {!!serviceKey && (
            <View style={styles.noteCard}>
              <Text style={styles.noteText}>
                Your service key — save this now. You'll need to enter it, along with your account
                email, every time you run batch geocoding. There's no recovery flow if you lose it.{' '}
                {serviceKeyEmailed
                  ? "We've also emailed it to you, so it's not just on this screen."
                  : "We couldn't confirm it was emailed to you, so this screen is the only copy right now — save it before you navigate away."}
              </Text>
              <Text selectable style={styles.serviceKeyText}>
                {serviceKey}
              </Text>
            </View>
          )}
        </>
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
  serviceKeyText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    backgroundColor: colors.neutral100,
    borderRadius: radius.md,
    padding: space[2],
    marginTop: space[2],
  },
  spacing: {
    marginTop: space[2],
  },
});
