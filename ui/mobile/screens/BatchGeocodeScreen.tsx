import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import BatchGeocodeForm from '../components/BatchGeocodeForm';

export default function BatchGeocodeScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <BatchGeocodeForm />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
