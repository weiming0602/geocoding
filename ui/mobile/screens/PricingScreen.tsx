import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import PricingContent from '../components/PricingContent';

export default function PricingScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <PricingContent />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
