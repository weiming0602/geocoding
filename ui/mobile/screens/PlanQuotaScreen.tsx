import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import PlanQuotaForm from '../components/PlanQuotaForm';

export default function PlanQuotaScreen({ onGoToPricing }: { onGoToPricing: () => void }) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <PlanQuotaForm onGoToPricing={onGoToPricing} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
