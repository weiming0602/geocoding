import {
  CormorantGaramond_600SemiBold,
  useFonts as useCormorantGaramond,
} from '@expo-google-fonts/cormorant-garamond';
import { Lora_400Regular, useFonts as useLora } from '@expo-google-fonts/lora';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import BatchGeocodeScreen from './screens/BatchGeocodeScreen';
import PlanQuotaScreen from './screens/PlanQuotaScreen';
import ReverseGeocodeScreen from './screens/ReverseGeocodeScreen';
import SingleGeocodeScreen from './screens/SingleGeocodeScreen';
import { colors } from '../shared/theme';

SplashScreen.preventAutoHideAsync();

type Screen = 'single' | 'batch' | 'reverse' | 'quota';

const TABS: { key: Screen; label: string }[] = [
  { key: 'single', label: 'Single Address' },
  { key: 'batch', label: 'Batch Geocode' },
  { key: 'reverse', label: 'Reverse Geocode' },
  { key: 'quota', label: 'Plan & Quota' },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>('single');
  const [headingLoaded] = useCormorantGaramond({ CormorantGaramond_600SemiBold });
  const [bodyLoaded] = useLora({ Lora_400Regular });

  const onLayout = useCallback(async () => {
    if (headingLoaded && bodyLoaded) {
      await SplashScreen.hideAsync();
    }
  }, [headingLoaded, bodyLoaded]);

  if (!headingLoaded || !bodyLoaded) {
    return null;
  }

  return (
    <SafeAreaView style={styles.container} onLayout={onLayout}>
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
      {screen === 'quota' && <PlanQuotaScreen />}

      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: colors.accent,
  },
  tabLabel: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    opacity: 0.7,
  },
  tabLabelActive: {
    color: colors.accent,
    opacity: 1,
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 15,
  },
});
