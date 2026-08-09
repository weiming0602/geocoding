import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import ImportAddressesForm, { type ImportWizardState } from '../components/ImportAddressesForm';

type Props = {
  state: ImportWizardState;
  onChange: (patch: Partial<ImportWizardState>) => void;
  onSendToBatch: (file: { name: string; content: string }) => void;
};

export default function ImportAddressesScreen({ state, onChange, onSendToBatch }: Props) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <ImportAddressesForm state={state} onChange={onChange} onSendToBatch={onSendToBatch} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
