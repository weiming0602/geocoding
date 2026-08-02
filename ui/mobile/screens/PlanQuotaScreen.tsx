import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import PlanQuotaForm from '../components/PlanQuotaForm';

export default function PlanQuotaScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <PlanQuotaForm />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
