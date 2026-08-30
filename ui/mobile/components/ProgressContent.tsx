import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { MILESTONES_NEWEST_FIRST } from '../../shared/milestones';
import { colors, space } from '../../shared/theme';

export default function ProgressContent() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Progress</Text>
      <Text style={styles.subtitle}>
        A running record of what's shipped so far, and what's next.
      </Text>

      {MILESTONES_NEWEST_FIRST.map((milestone, i) => (
        <View key={milestone.title} style={styles.row}>
          <View style={styles.railColumn}>
            <View
              style={[
                styles.dot,
                milestone.current ? styles.dotCurrent : styles.dotDone,
              ]}
            />
            {i < MILESTONES_NEWEST_FIRST.length - 1 && <View style={styles.rail} />}
          </View>
          <View style={styles.entry}>
            <Text style={styles.date}>{milestone.date}</Text>
            <View style={styles.titleRow}>
              <Text style={styles.entryTitle}>{milestone.title}</Text>
              {milestone.current && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>IN PROGRESS</Text>
                </View>
              )}
            </View>
            <Text style={styles.description}>{milestone.description}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    padding: space[4],
  },
  title: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 26,
    color: colors.text,
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    opacity: 0.7,
    marginBottom: space[6],
  },
  row: {
    flexDirection: 'row',
  },
  railColumn: {
    width: 12,
    alignItems: 'center',
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  dotDone: {
    backgroundColor: colors.accent,
  },
  dotCurrent: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: colors.accent,
  },
  rail: {
    width: 1,
    flex: 1,
    backgroundColor: colors.divider,
    marginTop: 4,
  },
  entry: {
    flex: 1,
    marginLeft: space[4],
    paddingBottom: space[6],
  },
  date: {
    fontFamily: 'Lora_400Regular',
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.accent,
    marginBottom: 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space[2],
  },
  entryTitle: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 18,
    color: colors.text,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: space[2],
    paddingVertical: 2,
    backgroundColor: colors.accent100,
  },
  badgeText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 9,
    letterSpacing: 0.5,
    color: colors.accent800,
  },
  description: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    opacity: 0.7,
    marginTop: 2,
  },
});
