import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { PRICING_TIERS, formatUsd, perAddressRate } from '../../shared/pricing';
import { colors, radius, space } from '../../shared/theme';
import CheckoutSection from './CheckoutSection';
import { Icon } from './icons';
import ThemedButton from './ThemedButton';

export default function PricingContent() {
  const [selectedTier, setSelectedTier] = useState<number | null>(null);

  if (selectedTier !== null) {
    return <CheckoutSection addressCount={selectedTier} onBack={() => setSelectedTier(null)} />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <Icon name="pricing" size={20} color={colors.accent} />
        <Text style={styles.title}>Bulk geocoding pricing</Text>
      </View>
      <Text style={styles.subtitle}>
        One-time packs of additional monthly quota for Batch geocoding. Single-address Geocode and
        Reverse geocode always stay free.
      </Text>

      {PRICING_TIERS.map((tier) => (
        <View key={tier.addressCount} style={styles.card}>
          {tier.popular && <Text style={styles.popularTag}>MOST POPULAR</Text>}
          <Text style={styles.cardKicker}>{tier.label}</Text>
          <Text style={styles.price}>{formatUsd(tier.priceCents)}</Text>
          <Text style={styles.cardMeta}>{perAddressRate(tier)}</Text>
          <View style={styles.spacing}>
            <ThemedButton title="Buy" onPress={() => setSelectedTier(tier.addressCount)} block />
          </View>
        </View>
      ))}

      <View style={[styles.card, styles.noteCard]}>
        <Text style={styles.cardMeta}>
          Purchases add to your account's monthly quota permanently (they don't expire at the end of
          the period).
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    padding: space[4],
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    marginBottom: 4,
  },
  title: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 26,
    color: colors.text,
  },
  subtitle: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    opacity: 0.7,
    marginBottom: space[6],
  },
  card: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    padding: space[3],
    marginBottom: space[4],
  },
  noteCard: {
    backgroundColor: colors.surface,
    borderColor: 'transparent',
  },
  popularTag: {
    fontFamily: 'Lora_400Regular',
    fontSize: 10,
    letterSpacing: 1,
    color: colors.accent,
    marginBottom: 4,
  },
  cardKicker: {
    fontFamily: 'Lora_400Regular',
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.accent,
    marginBottom: 4,
  },
  price: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 28,
    color: colors.text,
  },
  cardMeta: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
    opacity: 0.65,
  },
  spacing: {
    marginTop: space[2],
  },
});
