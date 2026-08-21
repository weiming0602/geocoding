import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import RoadAlertsForm from '../components/RoadAlertsForm';

type Props = {
  onNotificationsViewed?: () => void;
};

export default function RoadAlertsScreen({ onNotificationsViewed }: Props) {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <RoadAlertsForm onNotificationsViewed={onNotificationsViewed} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: 24,
  },
});
