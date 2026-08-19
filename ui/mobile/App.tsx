import {
  CormorantGaramond_600SemiBold,
  useFonts as useCormorantGaramond,
} from '@expo-google-fonts/cormorant-garamond';
import { Lora_400Regular, Lora_600SemiBold, useFonts as useLora } from '@expo-google-fonts/lora';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { getStoredAccount } from './components/roadAlertsStorage';
import BatchGeocodeScreen from './screens/BatchGeocodeScreen';
import FindPlacesScreen from './screens/FindPlacesScreen';
import HelpScreen from './screens/HelpScreen';
import ImportAddressesScreen from './screens/ImportAddressesScreen';
import PlanQuotaScreen from './screens/PlanQuotaScreen';
import PricingScreen from './screens/PricingScreen';
import ProgressScreen from './screens/ProgressScreen';
import ReverseGeocodeScreen from './screens/ReverseGeocodeScreen';
import RoadAlertsScreen from './screens/RoadAlertsScreen';
import SingleGeocodeScreen from './screens/SingleGeocodeScreen';
import { INITIAL_IMPORT_STATE, type ImportWizardState } from './components/ImportAddressesForm';
import { getRoadAlertsNotifications } from '../shared/api/client';
import { colors, space } from '../shared/theme';

SplashScreen.preventAutoHideAsync();

type Screen =
  | 'single'
  | 'batch'
  | 'reverse'
  | 'findPlaces'
  | 'roadAlerts'
  | 'import'
  | 'quota'
  | 'pricing'
  | 'progress'
  | 'help';

const TABS: { key: Screen; label: string }[] = [
  { key: 'single', label: 'Single Address' },
  { key: 'batch', label: 'Batch Geocode' },
  { key: 'reverse', label: 'Reverse Geocode' },
  { key: 'findPlaces', label: 'Find Places' },
  { key: 'roadAlerts', label: 'Road Alerts' },
  { key: 'import', label: 'Import Addresses' },
  { key: 'quota', label: 'Plan & Quota' },
  { key: 'pricing', label: 'Pricing' },
  { key: 'progress', label: 'Progress' },
  { key: 'help', label: 'Help' },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>('single');
  const [headingLoaded] = useCormorantGaramond({ CormorantGaramond_600SemiBold });
  const [bodyLoaded] = useLora({ Lora_400Regular, Lora_600SemiBold });

  // Screens fully unmount/remount on every tab switch (conditional
  // rendering below, not a hidden-but-mounted stack) -- Import
  // Addresses' wizard state lives here, above that, so going to Batch
  // and back via "Back to Import Addresses" returns to exactly where
  // the user left off instead of a reset wizard. See the same reasoning
  // in ui/desktop's ImportAddressesStateProvider.
  const [importState, setImportState] = useState<ImportWizardState>(INITIAL_IMPORT_STATE);
  const updateImportState = useCallback((patch: Partial<ImportWizardState>) => {
    setImportState((prev) => ({ ...prev, ...patch }));
  }, []);

  // pendingBatchFile/pendingBatchIds are one-shot (BatchGeocodeScreen
  // reports them consumed right after picking them up); arrivedFromImport
  // persists for the whole Batch visit and is reset only by a direct
  // tab-bar switch (goToScreen below), not by consuming or clearing the
  // file -- mirrors desktop's independent arrivedFromImport flag in
  // Batch.tsx. pendingBatchIds is the mapped ID column (if any), one per
  // address line in pendingBatchFile.content, same order.
  const [pendingBatchFile, setPendingBatchFile] = useState<{ name: string; content: string } | null>(null);
  const [pendingBatchIds, setPendingBatchIds] = useState<string[] | null>(null);
  const [arrivedFromImport, setArrivedFromImport] = useState(false);

  // Unseen-reply count for the Road Alerts tab label (e.g. "Road Alerts
  // · 2") -- there's no dedicated home screen or global notification
  // state in this app, so this lives only on the tab itself. Best-effort:
  // no stored account, or any fetch failure, just leaves the count at 0
  // rather than surfacing an error for a badge this minor.
  const [roadAlertsReplyCount, setRoadAlertsReplyCount] = useState(0);
  const fetchRoadAlertsReplyCount = useCallback(async () => {
    const account = await getStoredAccount();
    if (!account) {
      setRoadAlertsReplyCount(0);
      return;
    }
    try {
      const response = await getRoadAlertsNotifications({ email: account.email, serviceKey: account.serviceKey });
      setRoadAlertsReplyCount(response.replyCount);
    } catch {
      setRoadAlertsReplyCount(0);
    }
  }, []);

  useEffect(() => {
    fetchRoadAlertsReplyCount();
  }, [fetchRoadAlertsReplyCount]);

  const goToScreen = useCallback(
    (key: Screen) => {
      setArrivedFromImport(false);
      setScreen(key);
      if (key === 'roadAlerts') fetchRoadAlertsReplyCount();
    },
    [fetchRoadAlertsReplyCount]
  );

  const handleSendToBatch = useCallback((file: { name: string; content: string }, ids?: string[]) => {
    setPendingBatchFile(file);
    setPendingBatchIds(ids ?? null);
    setArrivedFromImport(true);
    setScreen('batch');
  }, []);

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
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabBarContent}
        >
          {TABS.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, screen === tab.key && styles.tabActive]}
              onPress={() => goToScreen(tab.key)}
            >
              <Text
                style={[styles.tabLabel, screen === tab.key && styles.tabLabelActive]}
                numberOfLines={1}
              >
                {tab.key === 'roadAlerts' && roadAlertsReplyCount > 0
                  ? `${tab.label} · ${roadAlertsReplyCount}`
                  : tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {screen === 'single' && <SingleGeocodeScreen />}
      {screen === 'batch' && (
        <BatchGeocodeScreen
          initialFile={pendingBatchFile}
          initialIds={pendingBatchIds}
          onConsumedInitialFile={() => {
            setPendingBatchFile(null);
            setPendingBatchIds(null);
          }}
          showBackToImport={arrivedFromImport}
          onBackToImport={() => goToScreen('import')}
        />
      )}
      {screen === 'reverse' && <ReverseGeocodeScreen />}
      {screen === 'findPlaces' && <FindPlacesScreen />}
      {screen === 'roadAlerts' && (
        <RoadAlertsScreen onNotificationsViewed={() => setRoadAlertsReplyCount(0)} />
      )}
      {screen === 'import' && (
        <ImportAddressesScreen state={importState} onChange={updateImportState} onSendToBatch={handleSendToBatch} />
      )}
      {screen === 'quota' && <PlanQuotaScreen />}
      {screen === 'pricing' && <PricingScreen />}
      {screen === 'progress' && <ProgressScreen />}
      {screen === 'help' && <HelpScreen />}

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
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  // Intrinsic-width tabs in a horizontally scrolling row -- flex:1 across
  // all 9 tabs is what made longer labels ("Reverse Geocode", "Import
  // Addresses") overlap their neighbors at real phone/tablet widths,
  // since nothing clipped or wrapped the overflow.
  tabBarContent: {
    flexDirection: 'row',
  },
  tab: {
    paddingVertical: 14,
    paddingHorizontal: space[3],
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
