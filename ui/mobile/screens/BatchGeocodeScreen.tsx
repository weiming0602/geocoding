import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import BatchGeocodeForm from '../components/BatchGeocodeForm';

type Props = {
  initialFile?: { name: string; content: string } | null;
  initialIds?: string[] | null;
  onConsumedInitialFile?: () => void;
  showBackToImport?: boolean;
  onBackToImport?: () => void;
};

export default function BatchGeocodeScreen(props: Props) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <BatchGeocodeForm {...props} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
