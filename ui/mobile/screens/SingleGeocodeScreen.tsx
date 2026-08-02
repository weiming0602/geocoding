import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import GeocodeForm from '../components/GeocodeForm';

export default function SingleGeocodeScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <GeocodeForm />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
