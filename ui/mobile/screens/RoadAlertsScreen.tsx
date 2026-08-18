import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import RoadAlertsForm from '../components/RoadAlertsForm';

export default function RoadAlertsScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <RoadAlertsForm />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
