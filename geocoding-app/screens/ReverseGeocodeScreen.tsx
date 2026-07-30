import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import ReverseGeocodeForm from '../components/ReverseGeocodeForm';

export default function ReverseGeocodeScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ReverseGeocodeForm />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
