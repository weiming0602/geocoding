import {
  CormorantGaramond_600SemiBold,
  useFonts as useCormorantGaramond,
} from '@expo-google-fonts/cormorant-garamond';
import { Lora_400Regular, Lora_600SemiBold, useFonts as useLora } from '@expo-google-fonts/lora';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { getStoredAccount } from './components/roadAlertsStorage';
import { BrandMark, Icon, type IconName } from './components/icons';
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
import { colors, radius, space } from '../shared/theme';

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

// icon values match ui/desktop's NAV_LINKS one-for-one (see
// components/icons.tsx's port-from-desktop comment) so the two apps'
// menus read as the same system, not two different icon sets.
const TABS: { key: Screen; label: string; icon: IconName }[] = [
  { key: 'single', label: 'Single Address', icon: 'geocode' },
  { key: 'batch', label: 'Batch Geocode', icon: 'batch' },
  { key: 'reverse', label: 'Reverse Geocode', icon: 'reverseGeocode' },
  { key: 'findPlaces', label: 'Find Places', icon: 'findPlaces' },
  { key: 'roadAlerts', label: 'Road Alerts', icon: 'roadAlerts' },
  { key: 'import', label: 'Import Addresses', icon: 'importAddresses' },
  { key: 'quota', label: 'Plan & Quota', icon: 'planQuota' },
  { key: 'pricing', label: 'Pricing', icon: 'pricing' },
  { key: 'progress', label: 'Progress', icon: 'progress' },
  { key: 'help', label: 'Help', icon: 'help' },
];

// Desktop's equivalent (styles.css's nav-item-hop) plays a one-shot hop
// whenever a nav pill newly becomes .active -- there's no persistent nav
// bar here to do the same trick on (this menu is a Modal that closes the
// instant a tab is picked), so instead the tapped row itself hops in
// place, and the actual navigation (onSelect) waits for the animation to
// finish rather than firing immediately -- otherwise the modal would
// close before the bounce was ever visible.
function MenuItem({
  tab,
  active,
  badge,
  onSelect,
}: {
  tab: { key: Screen; label: string; icon: IconName };
  active: boolean;
  badge?: string;
  onSelect: () => void;
}) {
  const bounce = useRef(new Animated.Value(0)).current;

  // 3 decreasing bounces, deliberately more ball-like than desktop's
  // floaty nav-item-hop keyframes (per feedback -- mobile should read as
  // an actual bounced ball, not a balloon): each rise eases out (like
  // gravity decelerating something thrown up) and each fall eases in
  // (gravity accelerating it back down), asymmetric rather than a
  // symmetric float, and quicker overall. Each peak targets a fraction of
  // `bounce`'s 0..1 range rather than a fresh 0..1 climb, so translateY/
  // scale below (interpolated off that same range) shrink proportionally
  // without needing separate interpolations per hop.
  const handlePress = () => {
    bounce.setValue(0);
    Animated.sequence([
      Animated.timing(bounce, { toValue: 1, duration: 130, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(bounce, { toValue: 0, duration: 110, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.timing(bounce, { toValue: 0.5, duration: 95, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(bounce, { toValue: 0, duration: 80, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.timing(bounce, { toValue: 0.22, duration: 70, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(bounce, { toValue: 0, duration: 60, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]).start(() => onSelect());
  };

  // translateY only -- no scale. This row is wide and short (an icon +
  // a label in a flexDirection: 'row'), so scaling it stretches width far
  // more than height in absolute pixels (its transform origin is the
  // center, and the row is much wider than tall) -- that read as
  // sideways motion instead of a vertical hop, which is the opposite of
  // what this is supposed to look like.
  const translateY = bounce.interpolate({ inputRange: [0, 1], outputRange: [0, -12] });

  return (
    <TouchableOpacity style={styles.modalOption} onPress={handlePress}>
      <Animated.View style={[styles.modalOptionRow, { transform: [{ translateY }] }]}>
        <Icon name={tab.icon} size={16} color={active ? colors.accent : colors.text} />
        <Text style={[styles.modalOptionText, active && styles.modalOptionTextActive]}>
          {badge ? `${tab.label} · ${badge}` : tab.label}
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('single');
  const [menuOpen, setMenuOpen] = useState(false);
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
      {/* Same giant, half-cropped, tilted BrandMark watermark as desktop's
          Layout.tsx, scaled down for a phone screen -- sized/positioned
          relative to this SafeAreaView (RN's `absolute` is always
          relative to the nearest ancestor View, there's no separate
          `fixed`), so it stays put as a backdrop behind whichever screen
          is showing rather than living inside any one screen's own
          ScrollView. pointerEvents="none" so it never intercepts a touch
          meant for whatever's drawn over it. */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', right: -140, bottom: -140, opacity: 0.07, transform: [{ rotate: '-22deg' }] }}
      >
        <BrandMark size={380} color={colors.text} />
      </View>

      <View style={styles.header}>
        <View style={styles.brandRow}>
          <BrandMark size={20} color={colors.accent} />
          <Text style={styles.brand}>Meridian</Text>
        </View>
        <TouchableOpacity
          onPress={() => setMenuOpen((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={menuOpen ? 'Close menu' : 'Open menu'}
        >
          <Text style={styles.menuButtonText}>☰ Menu</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={styles.modalCard}>
            {TABS.map((tab) => (
              <MenuItem
                key={tab.key}
                tab={tab}
                active={screen === tab.key}
                badge={tab.key === 'roadAlerts' && roadAlertsReplyCount > 0 ? String(roadAlertsReplyCount) : undefined}
                onSelect={() => {
                  goToScreen(tab.key);
                  setMenuOpen(false);
                }}
              />
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space[3],
    paddingHorizontal: space[4],
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
  },
  brand: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 20,
    color: colors.text,
  },
  menuButtonText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 15,
    color: colors.accent,
  },
  // Same modal shape as ImportAddressesForm.tsx's column-role picker --
  // a dimmed full-screen backdrop (closes on outside tap) behind a
  // centered card listing options, reused here rather than inventing a
  // second dropdown/menu visual language in this app.
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: space[4],
  },
  modalCard: {
    backgroundColor: colors.bg,
    borderRadius: radius.lg,
    padding: space[4],
  },
  modalOption: {
    paddingVertical: space[2],
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  modalOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  modalOptionText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 15,
    color: colors.text,
  },
  modalOptionTextActive: {
    color: colors.accent,
    fontFamily: 'CormorantGaramond_600SemiBold',
  },
});
