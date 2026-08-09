import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import FindPlacesForm from '../components/FindPlacesForm';

export default function FindPlacesScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <FindPlacesForm />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
