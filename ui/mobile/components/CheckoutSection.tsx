import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { findTier, formatUsd } from '../../shared/pricing';
import { colors, radius, space } from '../../shared/theme';
import ThemedButton from './ThemedButton';

type Props = {
  addressCount: number;
  onBack: () => void;
};

// Checkout redirects to Stripe's hosted page and relies on the browser
// coming back to this app's own URL afterward (CheckoutSection.web.tsx),
// which the native app has no equivalent of yet (it would need a deep-link
// return URL). This is the native (iOS/Android) fallback -- honest about
// the constraint rather than faking a payment UI that can't work here.
export default function CheckoutSection({ addressCount, onBack }: Props) {
  const tier = findTier(addressCount);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Checkout</Text>
      {tier && (
        <Text style={styles.subtitle}>
          {tier.label} for {formatUsd(tier.priceCents)}.
        </Text>
      )}
      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          Checkout isn't available in the native app yet — open the web app to complete this
          purchase.
        </Text>
      </View>
      <ThemedButton title="Back to pricing" onPress={onBack} variant="secondary" />
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
});
