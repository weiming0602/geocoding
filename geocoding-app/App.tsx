import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import BatchGeocodeScreen from './screens/BatchGeocodeScreen';
import SingleGeocodeScreen from './screens/SingleGeocodeScreen';

type Screen = 'single' | 'batch';

export default function App() {
  const [screen, setScreen] = useState<Screen>('single');

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, screen === 'single' && styles.tabActive]}
          onPress={() => setScreen('single')}
        >
          <Text style={[styles.tabLabel, screen === 'single' && styles.tabLabelActive]}>
            Single Address
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, screen === 'batch' && styles.tabActive]}
          onPress={() => setScreen('batch')}
        >
          <Text style={[styles.tabLabel, screen === 'batch' && styles.tabLabelActive]}>
            Batch Geocode
          </Text>
        </TouchableOpacity>
      </View>

      {screen === 'single' ? <SingleGeocodeScreen /> : <BatchGeocodeScreen />}

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
