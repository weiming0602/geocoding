import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { completeCheckout, createCheckoutSession } from '../../shared/api/client';
import { findTier, formatUsd } from '../../shared/pricing';
import { colors, radius, space } from '../../shared/theme';
import { checkoutReturnSession, checkoutReturnUrl } from '../checkoutReturn';
import ThemedButton from './ThemedButton';

// Purely cosmetic (which note/wording to show) -- the server is what
// actually decides test vs. live (an `sk_test_` vs. `sk_live_`
// STRIPE_SECRET_KEY). Keep this in sync with that so the checkout screen
// never tells a real paying customer "no real money moves".
const STRIPE_ENV = process.env.EXPO_PUBLIC_STRIPE_ENV === 'live' ? 'live' : 'test';

type Props = {
  addressCount: number;
  onBack: () => void;
};

type Status = 'idle' | 'redirecting' | 'completing' | 'error' | 'success';

// Same flow as ui/desktop/src/pages/Checkout.tsx: redirect to Stripe's
// hosted checkout page, then -- back on a fresh page load with
// `session_id` in the URL (see checkoutReturn.ts) -- have the server
// confirm the payment with Stripe and grant the quota.
export default function CheckoutSection({ addressCount, onBack }: Props) {
  const tier = findTier(addressCount);
  const [{ sessionId, canceled }] = useState(checkoutReturnSession);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>(sessionId ? 'completing' : 'idle');
  const [message, setMessage] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [serviceKeyEmailed, setServiceKeyEmailed] = useState(false);
  // See Checkout.tsx -- guards against React's dev-mode double effect.
  const completedSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId || completedSessionRef.current === sessionId) return;
    completedSessionRef.current = sessionId;
    completeCheckout(sessionId)
      .then((body) => {
        setStatus('success');
        setServiceKey(body.serviceKey ?? '');
        setServiceKeyEmailed(Boolean(body.serviceKeyEmailed));
        setMessage(
          body.stubbed
            ? `Done (test mode, no real charge) — ${body.tier.toLocaleString()} total monthly addresses now available for ${body.email}.`
            : `Payment received${STRIPE_ENV === 'test' ? ' (Stripe test mode)' : ''} — ${body.tier.toLocaleString()} total monthly addresses now available for ${body.email}.`
        );
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err instanceof Error ? err.message : 'Could not confirm the payment.');
      });
  }, [sessionId]);

  async function handlePay() {
    if (!tier) return;
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setStatus('error');
      setMessage('Enter your account email before paying.');
      return;
    }
    setStatus('redirecting');
    setMessage('');
    try {
      const { url } = await createCheckoutSession({
        email: trimmedEmail,
        addressCount: tier.addressCount,
        returnUrl: checkoutReturnUrl(tier.addressCount),
      });
      window.location.assign(url);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Could not start checkout.');
    }
  }

  if (!tier) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Checkout</Text>
      <Text style={styles.subtitle}>
        {tier.label} for {formatUsd(tier.priceCents)}.
      </Text>

      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          {STRIPE_ENV === 'live'
            ? "This is a real charge. Continuing takes you to Stripe's secure checkout page to pay by card for the amount above; you'll come back here once it's done."
            : "Test mode: this runs Stripe's real checkout flow in test mode — no real money moves (pay with Stripe's test card 4242 4242 4242 4242, any future expiry, any CVC). Your account's quota is topped up for real either way."}
        </Text>
      </View>

      {status !== 'success' && status !== 'completing' && (
        <>
          {canceled && status === 'idle' && (
            <Text style={styles.message}>Checkout canceled — nothing was charged.</Text>
          )}
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

          <View style={styles.payButton}>
            <ThemedButton
              title={status === 'redirecting' ? 'Opening checkout…' : `Continue to payment — ${formatUsd(tier.priceCents)}`}
              onPress={handlePay}
              disabled={status === 'redirecting'}
            />
          </View>
        </>
      )}

      {status === 'completing' && <Text style={styles.message}>Confirming your payment…</Text>}

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
  payButton: {
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
