import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import BatchGeocodeScreen from './screens/BatchGeocodeScreen';
import ReverseGeocodeScreen from './screens/ReverseGeocodeScreen';
import SingleGeocodeScreen from './screens/SingleGeocodeScreen';

type Screen = 'single' | 'batch' | 'reverse';

const TABS: { key: Screen; label: string }[] = [
  { key: 'single', label: 'Single Address' },
  { key: 'batch', label: 'Batch Geocode' },
  { key: 'reverse', label: 'Reverse Geocode' },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>('single');

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.tabBar}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, screen === tab.key && styles.tabActive]}
            onPress={() => setScreen(tab.key)}
          >
            <Text style={[styles.tabLabel, screen === tab.key && styles.tabLabelActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {screen === 'single' && <SingleGeocodeScreen />}
      {screen === 'batch' && <BatchGeocodeScreen />}
      {screen === 'reverse' && <ReverseGeocodeScreen />}

      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: '#2196F3',
  },
  tabLabel: {
    fontSize: 14,
    color: '#666',
  },
  tabLabelActive: {
    color: '#2196F3',
    fontWeight: '600',
  },
});
