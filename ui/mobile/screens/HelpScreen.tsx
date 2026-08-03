import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import HelpContent from '../components/HelpContent';

export default function HelpScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <HelpContent />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
