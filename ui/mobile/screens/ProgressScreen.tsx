import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import ProgressContent from '../components/ProgressContent';

export default function ProgressScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ProgressContent />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
