import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity } from 'react-native';

import { colors } from '../../shared/theme';

type Variant = 'primary' | 'secondary' | 'ghost';

type Props = {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: Variant;
  block?: boolean;
};

// RN's built-in <Button> can't render an outlined/unfilled style (it's a
// solid platform-colored button on Android, plain text on iOS) -- the
// Classical design system's buttons are outlined or ghost, never solid
// fill, so this replaces it everywhere in this app.
export default function ThemedButton({ title, onPress, disabled, loading, variant = 'primary', block }: Props) {
  const isDisabled = disabled || loading;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      style={[styles.base, variantStyles[variant], block && styles.block, isDisabled && styles.disabled]}
      activeOpacity={0.7}
    >
      {loading ? (
        <ActivityIndicator size="small" color={variant === 'secondary' ? colors.text : colors.accent} />
      ) : (
        <Text style={[styles.label, variantLabelStyles[variant]]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
    borderWidth: 1,
    paddingVertical: 9,
    paddingHorizontal: 17,
  },
  block: {
    width: '100%',
  },
  disabled: {
    opacity: 0.45,
  },
  label: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 15,
  },
});

const variantStyles = StyleSheet.create({
  primary: { borderColor: colors.accent, backgroundColor: 'transparent' },
  secondary: { borderColor: colors.divider, backgroundColor: 'transparent' },
  ghost: { borderColor: 'transparent', backgroundColor: 'transparent', paddingHorizontal: 5 },
});

const variantLabelStyles = StyleSheet.create({
  primary: { color: colors.accent },
  secondary: { color: colors.text },
  ghost: { color: colors.accent },
});
