import * as Location from 'expo-location';
import * as Speech from 'expo-speech';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  ApiError,
  emailRoadAlert,
  getRoadAlertsPreferences,
  getRoadAlertsTopic,
  getRoadAlertsUsername,
  getRoadReroute,
  getRoadSignals,
  getTestWeightedPoints,
  getWeightedPoints,
  markRoadAlertsNotificationsViewed,
  postRoadAlertsStatement,
  postWeightedPointPing,
  updateRoadAlertsPreferences,
  updateRoadAlertsUsername,
} from '../../shared/api/client';
import type {
  RoadAlertsTopicResponse,
  RoadRerouteResponse,
  RoadSignal,
  RoadSignalSeverity,
} from '../../shared/api/types';
import { bearingDegrees, haversineDistanceMeters, isAhead } from '../../shared/geo';
import { buildGoogleMapsDirectionsUrl } from '../../shared/googleMapsDirections';
import { HAZARD_CATEGORY_ICONS, HAZARD_CATEGORY_LABELS } from '../../shared/hazardCategories';
import { findAlertsForWeightedPoints, type WeightedPoint } from '../../shared/roadAlertsMatching';
import { colors, radius, space } from '../../shared/theme';
import RoadAlertsMap, { ROUTE_COLORS } from './RoadAlertsMap';
import RoadAlertsRegistration from './RoadAlertsRegistration';
import { Icon } from './icons';
import ThemedButton from './ThemedButton';
import { clearStoredAccount, getStoredAccount, type StoredRoadAlertsAccount } from './roadAlertsStorage';
import { isSpeechRecognitionAvailable, listenOnce, matchesSaveCommand } from './webSpeechRecognition';

type DetailLevel = 'brief' | 'average' | 'deep';

const DETAIL_OPTIONS: { label: string; value: DetailLevel }[] = [
  { label: 'Brief', value: 'brief' },
  { label: 'Average', value: 'average' },
  { label: 'Deep', value: 'deep' },
];

const RADIUS_METERS = 10000;
// Ties polling to real movement (watchPositionAsync's own distanceInterval)
// rather than a separate timer, but still caps how often the free public
//511 API gets hit if the device reports position rapidly.
const POLL_MIN_INTERVAL_MS = 15000;
// Much coarser than POLL_MIN_INTERVAL_MS on purpose -- routine-route
// learning doesn't need anywhere near hazard-checking's resolution, and
// a tighter interval would mean more battery/data spent on writes than
// the feature is worth. Real-world tuning is exactly what
// geocoding-server/src/weightedPoints.js's QUALIFYING_WINDOW_DAYS/
// MIN_PINGS_TO_QUALIFY, and this interval, are expected to need once
// there's real usage data to look at.
const WEIGHTED_POINT_PING_INTERVAL_MS = 3 * 60 * 1000;

const SEVERITY_LABELS: Record<RoadSignalSeverity, string> = {
  serious: 'Serious',
  need_to_know: 'Need to know',
  proximity: 'Proximity',
  fun_to_know: 'Fun to know',
};

const SEVERITY_COLORS: Record<RoadSignalSeverity, string> = {
  serious: colors.errorText,
  need_to_know: colors.accent,
  proximity: colors.accent2,
  fun_to_know: colors.neutral500,
};

function metersLabel(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

// Prefers lastUpdatedAt over createdAt -- same "how current is this,
// really" reasoning as the server's own sortByFreshness (roadSignals.js),
// which already orders the list by this same field so the newest alert is
// always on top; this just puts a human-readable label on that ordering.
function freshnessLabel(signal: RoadSignal): string {
  const raw = signal.lastUpdatedAt || signal.createdAt;
  if (!raw) return 'time unknown';
  const ms = Date.now() - new Date(raw).getTime();
  if (Number.isNaN(ms)) return 'time unknown';
  if (ms < 60_000) return 'updated just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `updated ${days}d ago`;
}

// Alerts speak automatically at every tier except fun_to_know (per
// docs/ROAD_ALERTS_DESIGN.md's "never interrupts, never spoken
// automatically" rule) -- manual replay via each row's Speak button is
// the only way a fun_to_know item is ever heard.
function shouldAutoSpeak(severity: RoadSignalSeverity): boolean {
  return severity !== 'fun_to_know';
}

type Props = {
  // The user's routine streets (docs/ROAD_ALERTS_DESIGN.md's weighted
  // subgraph) -- optional and empty by default, since nothing in this app
  // collects them yet (that's the on-device trip-learning piece, still
  // unbuilt). Defaulting to empty keeps today's behavior (alert on
  // anything ahead within radius) unchanged for every real caller until a
  // real source exists.
  weightedPoints?: WeightedPoint[];
  // Called once this screen has marked reply notifications as viewed
  // (see the mount effect below) -- App.tsx uses this to zero out the
  // Road Alerts tab's badge immediately, rather than waiting for its
  // own next poll.
  onNotificationsViewed?: () => void;
};

export default function RoadAlertsForm({ weightedPoints = [], onNotificationsViewed }: Props) {
  // undefined = still checking stored credentials; null = none found (or
  // cleared) -- show registration; set = ready to use.
  const [account, setAccount] = useState<StoredRoadAlertsAccount | null | undefined>(undefined);
  const [registrationReason, setRegistrationReason] = useState<string | null>(null);

  const [watching, setWatching] = useState(false);
  const [position, setPosition] = useState<{ latitude: number; longitude: number; heading: number | null } | null>(
    null
  );
  const [signals, setSignals] = useState<RoadSignal[]>([]);
  const [onRouteIds, setOnRouteIds] = useState<Set<string>>(new Set());
  // Fake, developer-seeded weighted points from the server's test-only
  // store (geocoding-server/src/testWeightedPoints.js) -- 404s (and stays
  // empty, silently) unless that server has ALLOW_TEST_WEIGHTED_POINTS
  // set, which is off by default. Merged with the real ones (below) and
  // the `weightedPoints` prop so a real source and this test aid can
  // both supply routine points at once.
  const [testWeightedPoints, setTestWeightedPoints] = useState<WeightedPoint[]>([]);
  // The real, always-on store (geocoding-server/src/weightedPoints.js) --
  // only ever contains *qualified* points (see that module), built up
  // from this same session's own pings (below) plus any earlier ones.
  const [realWeightedPoints, setRealWeightedPoints] = useState<WeightedPoint[]>([]);
  // Spoken alerts default to the shortest form on purpose -- something a
  // driver hears while approaching a hazard should be as small as
  // possible; a fuller account belongs in email (e.g. a future
  // voice-triggered "save this alert" digest), not read aloud at speed.
  const [detailLevel, setDetailLevel] = useState<DetailLevel>('brief');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  // Whether saved alerts ("save"/"keep"/"email" voice command) also feed
  // a daily email digest -- opt-in, default false, so fetched fresh from
  // the server on every account load rather than persisted alongside the
  // stored account credentials (roadAlertsStorage.ts only stores
  // email/serviceKey, not preferences).
  const [digestOptIn, setDigestOptIn] = useState(false);
  const [digestOptInSaving, setDigestOptInSaving] = useState(false);
  // Display name shown alongside anything the account posts (see
  // roadAlertsStorage.ts's comment on digestOptIn -- same reasoning:
  // fetched fresh, not persisted alongside the stored account
  // credentials, since it can change server-side independent of the
  // device). null = fetched, not set yet; undefined = not fetched yet.
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  // The alert list is the primary thing a driver needs -- registration,
  // digest/username, spoken-detail level, and manual test coordinates are
  // all setup/testing concerns that shouldn't sit between opening this
  // screen and seeing what's nearby. Collapsed by default; a driver who
  // never opens it still gets alerts, since watching now starts on its own
  // (see the auto-start effect below) instead of waiting on a Start press.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // "Save this" voice command per alert row -- web-only (see
  // webSpeechRecognition.ts). Keyed by signal id so each row shows its
  // own status; voiceListeningSignalId gates against starting a second
  // mic session while one's already listening.
  const [voiceListeningSignalId, setVoiceListeningSignalId] = useState<string | null>(null);
  const [voiceStatusBySignalId, setVoiceStatusBySignalId] = useState<Record<string, string>>({});
  const speechRecognitionAvailable = useMemo(() => isSpeechRecognitionAvailable(), []);

  // Comments on a road topic -- one panel open at a time (expandedSignalId),
  // matching the existing one-mic-session-at-a-time philosophy above.
  // topicBySignalId holds either the fetched topic/statements, 'loading'
  // while the fetch is in flight, or 'error' if it failed.
  const [expandedSignalId, setExpandedSignalId] = useState<string | null>(null);
  const [topicBySignalId, setTopicBySignalId] = useState<Record<string, RoadAlertsTopicResponse | 'loading' | 'error'>>(
    {}
  );
  const [draftStatementBySignalId, setDraftStatementBySignalId] = useState<Record<string, string>>({});
  const [replyingToStatementId, setReplyingToStatementId] = useState<number | null>(null);
  const [draftReplyText, setDraftReplyText] = useState('');
  const [postingSignalId, setPostingSignalId] = useState<string | null>(null);
  // Separate from voiceListeningSignalId (the save-command mic) on
  // purpose -- lower risk of regressing that already-working feature by
  // overloading its state with a second, differently-shaped use case.
  const [voiceListeningStatementSignalId, setVoiceListeningStatementSignalId] = useState<string | null>(null);
  const [voiceStatementStatusBySignalId, setVoiceStatementStatusBySignalId] = useState<Record<string, string>>({});

  // Inline map -- one open at a time, same reasoning as the comments panel
  // above. Opening it needs no server round trip (just the driver's
  // current position and the signal's own lat/lon); "Show a way around
  // this" reuses the same panel, layering the fetched route options and
  // rejoin point on top once they arrive (see rerouteBySignalId below).
  const [mapOpenSignalId, setMapOpenSignalId] = useState<string | null>(null);
  const [expandedRerouteSignalId, setExpandedRerouteSignalId] = useState<string | null>(null);
  const [rerouteBySignalId, setRerouteBySignalId] = useState<
    Record<string, RoadRerouteResponse | 'loading' | 'error'>
  >({});
  // Which option row was last tapped, so RoadAlertsMap can call out the
  // matching route -- touch equivalent of desktop's hover-to-highlight.
  // Not keyed per signal, same reasoning as mapOpenSignalId above.
  const [highlightedRouteIndex, setHighlightedRouteIndex] = useState<number | null>(null);

  // Manual testing input -- typed coordinates (+ optional heading) in
  // place of a real GPS fix, so a specific "approaching a hazard" scenario
  // can be checked on demand instead of needing to actually be there.
  // Independent of the Start/Stop GPS watch below; either can drive a
  // check.
  const [manualLatitude, setManualLatitude] = useState('');
  const [manualLongitude, setManualLongitude] = useState('');
  const [manualHeading, setManualHeading] = useState('');
  const [manualChecking, setManualChecking] = useState(false);

  const subscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const lastFetchAtRef = useRef(0);
  const spokenIdsRef = useRef<Set<string>>(new Set());
  // Throttles weighted-point pings independently of lastFetchAtRef's
  // (much tighter) hazard-check throttle -- see
  // WEIGHTED_POINT_PING_INTERVAL_MS.
  const lastWeightedPingAtRef = useRef(0);
  // True only for the very first position fix after a Start press --
  // that fix is this trip's origin, reported with isEndpoint so it's
  // never recorded as a weighted point. Reset in handleStart.
  const isFirstPositionOfSessionRef = useRef(true);
  // Latest known fix, read from handleStop to report the trip's actual
  // endpoint -- a ref (not just the `position` state) so handleStop
  // doesn't need `position` in its own dependency array, which would
  // otherwise change identity on every GPS update.
  const positionRef = useRef<{ latitude: number; longitude: number } | null>(null);
  // Read inside the position-watch callback without re-subscribing every
  // time either setting changes -- watchPositionAsync is only set up once
  // per Start press, not on every render.
  const voiceEnabledRef = useRef(voiceEnabled);
  const detailLevelRef = useRef(detailLevel);
  const accountRef = useRef(account);
  const weightedPointsRef = useRef<WeightedPoint[]>(weightedPoints);
  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);
  useEffect(() => {
    detailLevelRef.current = detailLevel;
  }, [detailLevel]);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);
  useEffect(() => {
    weightedPointsRef.current = [...weightedPoints, ...realWeightedPoints, ...testWeightedPoints];
  }, [weightedPoints, realWeightedPoints, testWeightedPoints]);

  // One-shot fetch of any fake weighted points seeded server-side for
  // this account (see the testWeightedPoints state comment above) --
  // re-fetched if the signed-in account changes. Any failure (404 when
  // disabled, a network error, whatever) just leaves this empty; it's a
  // test aid, never allowed to surface an error or block the real
  // feature.
  useEffect(() => {
    if (!account) {
      setTestWeightedPoints([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await getTestWeightedPoints({ email: account.email, serviceKey: account.serviceKey });
        if (!cancelled) {
          setTestWeightedPoints(
            response.weightedPoints.map((p) => ({
              latitude: p.latitude,
              longitude: p.longitude,
              weight: p.weight,
              tlid: p.tlid ?? undefined,
            }))
          );
        }
      } catch {
        if (!cancelled) setTestWeightedPoints([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account]);

  // One-shot fetch of this account's real, already-qualified weighted
  // points (see the realWeightedPoints state comment above) -- also
  // re-fetched from pingWeightedPoint below whenever a new ping might
  // have just pushed a point past its qualifying threshold, so a route
  // that becomes routine *during* this same session is usable for
  // matching without waiting for the next account change/app restart.
  const refreshRealWeightedPoints = useCallback(async () => {
    const current = accountRef.current;
    if (!current) return;
    try {
      const response = await getWeightedPoints({ email: current.email, serviceKey: current.serviceKey });
      setRealWeightedPoints(
        response.weightedPoints.map((p) => ({
          latitude: p.latitude,
          longitude: p.longitude,
          weight: p.weight,
          tlid: p.tlid ?? undefined,
        }))
      );
    } catch {
      // Best-effort, same reasoning as the test-weighted-points fetch --
      // never allowed to surface an error or block hazard alerting.
    }
  }, []);

  useEffect(() => {
    if (!account) {
      setRealWeightedPoints([]);
      return;
    }
    refreshRealWeightedPoints();
  }, [account, refreshRealWeightedPoints]);

  // Reports one GPS ping toward the account's routine-route model (see
  // geocoding-server/src/weightedPoints.js). Fire-and-forget: a failure
  // here is background-enhancement noise, never something that should
  // interrupt or delay hazard alerting.
  const pingWeightedPoint = useCallback(
    async (latitude: number, longitude: number, isEndpoint: boolean) => {
      const current = accountRef.current;
      if (!current) return;
      try {
        await postWeightedPointPing({ email: current.email, serviceKey: current.serviceKey, latitude, longitude, isEndpoint });
        if (!isEndpoint) refreshRealWeightedPoints();
      } catch {
        // best-effort -- see above
      }
    },
    [refreshRealWeightedPoints]
  );

  useEffect(() => {
    (async () => {
      const stored = await getStoredAccount();
      setAccount(stored);
    })();
  }, []);

  // Digest opt-in, like the test-weighted-points fetch above, is
  // best-effort: any failure just leaves the toggle at its default
  // (off) rather than surfacing an error for a preference this minor.
  useEffect(() => {
    if (!account) {
      setDigestOptIn(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await getRoadAlertsPreferences({ email: account.email, serviceKey: account.serviceKey });
        if (!cancelled) setDigestOptIn(response.digestOptIn);
      } catch {
        if (!cancelled) setDigestOptIn(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account]);

  // Same best-effort, fetch-fresh pattern as digestOptIn above.
  useEffect(() => {
    if (!account) {
      setUsername(undefined);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await getRoadAlertsUsername({ email: account.email, serviceKey: account.serviceKey });
        if (!cancelled) setUsername(response.username);
      } catch {
        if (!cancelled) setUsername(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account]);

  // Marks reply notifications as viewed once this screen (and an
  // account) has actually loaded -- best-effort, same reasoning as
  // above: a failure here just means the tab badge doesn't clear yet,
  // not something worth surfacing to the driver.
  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    (async () => {
      try {
        await markRoadAlertsNotificationsViewed({ email: account.email, serviceKey: account.serviceKey });
        if (!cancelled) onNotificationsViewed?.();
      } catch {
        // best-effort -- see above
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, onNotificationsViewed]);

  const speakSignal = useCallback((signal: RoadSignal) => {
    if (!voiceEnabledRef.current) return;
    Speech.speak(signal.speech[detailLevelRef.current]);
  }, []);

  const handleStop = useCallback(() => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
    Speech.stop();
    setWatching(false);

    // The last known fix is this trip's destination -- reported with
    // isEndpoint so it's never recorded as a weighted point, same
    // reasoning as the origin ping in onPosition below.
    const lastPosition = positionRef.current;
    if (lastPosition) {
      pingWeightedPoint(lastPosition.latitude, lastPosition.longitude, true);
    }
  }, [pingWeightedPoint]);

  const fetchSignals = useCallback(
    async (latitude: number, longitude: number, heading: number | null) => {
      const current = accountRef.current;
      if (!current) return;
      try {
        const response = await getRoadSignals({
          latitude,
          longitude,
          radiusMeters: RADIUS_METERS,
          email: current.email,
          serviceKey: current.serviceKey,
        });
        setSignals(response.signals);
        setPartial(response.partial);
        setError(null);

        // Hazards that fall between here and a street the user actually
        // drives regularly -- real 511 data, cross-referenced against
        // whatever routine data the caller has (empty until the
        // trip-learning piece exists, see the Props comment above). A
        // route match is treated as "ahead" unconditionally below: the
        // corridor-to-a-routine-point geometry already proves relevance,
        // so it shouldn't get silently dropped by a momentary bad heading
        // reading (e.g. stopped at a light) the way a plain cone check
        // would.
        const routeAlerts = findAlertsForWeightedPoints(
          { latitude, longitude },
          weightedPointsRef.current,
          response.signals
        );
        const onRouteIds = new Set(routeAlerts.map((a) => a.signal.id));
        setOnRouteIds(onRouteIds);

        for (const signal of response.signals) {
          if (spokenIdsRef.current.has(signal.id)) continue;
          if (typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') continue;
          const bearing = bearingDegrees(
            { latitude, longitude },
            { latitude: signal.latitude, longitude: signal.longitude }
          );
          const ahead = onRouteIds.has(signal.id) || isAhead(heading, bearing);
          spokenIdsRef.current.add(signal.id);
          if (ahead && shouldAutoSpeak(signal.severity)) {
            speakSignal(signal);
          }
        }
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) {
          await clearStoredAccount();
          handleStop();
          setAccount(null);
          setRegistrationReason("We couldn't verify your Road Alerts account -- please register again below.");
          return;
        }
        const message = err instanceof Error ? err.message : 'Could not check for road alerts.';
        setError(message);
      }
    },
    [speakSignal, handleStop]
  );

  const onPosition = useCallback(
    (location: Location.LocationObject) => {
      const { latitude, longitude, heading } = location.coords;
      setPosition({ latitude, longitude, heading });
      positionRef.current = { latitude, longitude };

      const now = Date.now();
      if (now - lastFetchAtRef.current >= POLL_MIN_INTERVAL_MS) {
        lastFetchAtRef.current = now;
        fetchSignals(latitude, longitude, heading);
      }

      // The first fix after Start is this trip's origin -- reported with
      // isEndpoint so it's never recorded as a weighted point (see
      // pingWeightedPoint), and doesn't count against the throttle below
      // since it's not a routine-route sample at all.
      if (isFirstPositionOfSessionRef.current) {
        isFirstPositionOfSessionRef.current = false;
        pingWeightedPoint(latitude, longitude, true);
        return;
      }

      if (now - lastWeightedPingAtRef.current < WEIGHTED_POINT_PING_INTERVAL_MS) return;
      lastWeightedPingAtRef.current = now;
      pingWeightedPoint(latitude, longitude, false);
    },
    [fetchSignals, pingWeightedPoint]
  );

  const handleStart = useCallback(async () => {
    setError(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        throw new Error('Location permission was not granted.');
      }
      isFirstPositionOfSessionRef.current = true;
      const subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 25 },
        onPosition
      );
      subscriptionRef.current = subscription;
      setWatching(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not start watching your location.';
      setError(message);
    }
  }, [onPosition]);

  // Starts watching as soon as an account is ready, rather than waiting on
  // a Start press -- a driver opening this screen should see alerts show
  // up on their own. Depends only on `account` (not `watching`) so this
  // fires once per sign-in rather than re-firing every time Stop (in
  // Settings) flips `watching` back to false.
  useEffect(() => {
    if (account) {
      handleStart();
    }
  }, [account, handleStart]);

  const handleManualCheck = useCallback(async () => {
    const latitude = Number(manualLatitude);
    const longitude = Number(manualLongitude);
    const headingText = manualHeading.trim();
    const heading = headingText === '' ? null : Number(headingText);

    if (manualLatitude.trim() === '' || Number.isNaN(latitude)) {
      setError('Enter a valid latitude, e.g. 43.8570.');
      return;
    }
    if (manualLongitude.trim() === '' || Number.isNaN(longitude)) {
      setError('Enter a valid longitude, e.g. -70.1030.');
      return;
    }
    if (headingText !== '' && Number.isNaN(heading)) {
      setError('Heading must be a number in degrees, or left blank.');
      return;
    }

    setError(null);
    setPosition({ latitude, longitude, heading });
    // Re-announces every match on each press, unlike the GPS-driven path --
    // repeatedly checking the same typed coordinates to confirm an alert
    // still fires (e.g. after adding a test weighted point) would
    // otherwise go silent the second time, since spokenIdsRef is what
    // stops a real drive from re-speaking the same hazard over and over.
    spokenIdsRef.current.clear();
    setManualChecking(true);
    try {
      await fetchSignals(latitude, longitude, heading);
    } finally {
      setManualChecking(false);
    }
  }, [manualLatitude, manualLongitude, manualHeading, fetchSignals]);

  // Arms the mic for one utterance; "save"/"keep"/"email" emails this
  // specific signal to the account's own address. Guarded against a
  // second concurrent session (voiceListeningSignalId) rather than
  // queueing -- the design doc's own "Queueing" open question is about
  // spoken alerts overlapping, not mic sessions, but the same
  // one-at-a-time reasoning applies here.
  const handleListenForSaveCommand = useCallback(
    async (signal: RoadSignal) => {
      const current = accountRef.current;
      if (!current || voiceListeningSignalId) return;

      setVoiceListeningSignalId(signal.id);
      setVoiceStatusBySignalId((prev) => ({ ...prev, [signal.id]: 'Listening…' }));
      try {
        const transcript = await listenOnce();
        if (!transcript || !matchesSaveCommand(transcript)) {
          setVoiceStatusBySignalId((prev) => ({
            ...prev,
            [signal.id]: transcript ? `Heard "${transcript}" -- no save command in that.` : "Didn't catch anything.",
          }));
          return;
        }

        const result = await emailRoadAlert({ email: current.email, serviceKey: current.serviceKey, signal });
        setVoiceStatusBySignalId((prev) => ({
          ...prev,
          [signal.id]: result.emailed
            ? 'Emailed to you.'
            : result.stubbed
              ? 'Would be emailed -- this server has no email delivery configured yet.'
              : 'Could not send the email.',
        }));
      } catch {
        setVoiceStatusBySignalId((prev) => ({ ...prev, [signal.id]: 'Could not check for a voice command.' }));
      } finally {
        setVoiceListeningSignalId(null);
      }
    },
    [voiceListeningSignalId]
  );

  const handleUseDifferentEmail = useCallback(async () => {
    handleStop();
    await clearStoredAccount();
    setRegistrationReason(null);
    setAccount(null);
  }, [handleStop]);

  const handleToggleDigest = useCallback(async () => {
    const current = accountRef.current;
    if (!current || digestOptInSaving) return;
    const next = !digestOptIn;
    setDigestOptInSaving(true);
    try {
      const response = await updateRoadAlertsPreferences({
        email: current.email,
        serviceKey: current.serviceKey,
        digestOptIn: next,
      });
      setDigestOptIn(response.digestOptIn);
    } catch {
      // Leave the toggle at its last-known-good value on failure --
      // this is a minor preference, not worth a dedicated error banner.
    } finally {
      setDigestOptInSaving(false);
    }
  }, [digestOptIn, digestOptInSaving]);

  const handleSaveUsername = useCallback(async () => {
    const current = accountRef.current;
    const trimmed = usernameDraft.trim();
    if (!current || usernameSaving || !trimmed) return;
    setUsernameSaving(true);
    try {
      const response = await updateRoadAlertsUsername({
        email: current.email,
        serviceKey: current.serviceKey,
        username: trimmed,
      });
      setUsername(response.username);
      setUsernameDraft('');
    } catch {
      // Leave the draft in place on failure so the driver doesn't lose
      // what they typed and can just press the button again.
    } finally {
      setUsernameSaving(false);
    }
  }, [usernameDraft, usernameSaving]);

  const handleToggleComments = useCallback(
    async (signal: RoadSignal) => {
      if (expandedSignalId === signal.id) {
        setExpandedSignalId(null);
        return;
      }
      setExpandedSignalId(signal.id);
      setReplyingToStatementId(null);
      if (topicBySignalId[signal.id]) return; // already fetched once this session

      const current = accountRef.current;
      if (!current || typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') return;

      setTopicBySignalId((prev) => ({ ...prev, [signal.id]: 'loading' }));
      try {
        const response = await getRoadAlertsTopic({
          latitude: signal.latitude,
          longitude: signal.longitude,
          email: current.email,
          serviceKey: current.serviceKey,
        });
        setTopicBySignalId((prev) => ({ ...prev, [signal.id]: response }));
      } catch {
        setTopicBySignalId((prev) => ({ ...prev, [signal.id]: 'error' }));
      }
    },
    [expandedSignalId, topicBySignalId]
  );

  const handleToggleMap = useCallback((signal: RoadSignal) => {
    setHighlightedRouteIndex(null);
    setMapOpenSignalId((current) => (current === signal.id ? null : signal.id));
  }, []);

  // Mirrors desktop's handleToggleReroute (RoadAlerts.tsx) -- same
  // /road-signals/reroute call, same per-signal cache-once-fetched
  // behavior. Also opens the map panel (if not already open) so the
  // driver sees the route the moment it arrives, rather than fetching
  // route data behind a still-closed map.
  const handleToggleReroute = useCallback(
    async (signal: RoadSignal) => {
      setHighlightedRouteIndex(null);
      if (expandedRerouteSignalId === signal.id) {
        setExpandedRerouteSignalId(null);
        return;
      }
      setExpandedRerouteSignalId(signal.id);
      setMapOpenSignalId(signal.id);
      if (rerouteBySignalId[signal.id]) return; // already fetched once this session

      const current = accountRef.current;
      if (!current || !position || typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') {
        return;
      }

      setRerouteBySignalId((prev) => ({ ...prev, [signal.id]: 'loading' }));
      try {
        const response = await getRoadReroute({
          driverLatitude: position.latitude,
          driverLongitude: position.longitude,
          driverHeading: position.heading,
          hazardLatitude: signal.latitude,
          hazardLongitude: signal.longitude,
          hazardRoadway: signal.roadway ?? undefined,
          email: current.email,
          serviceKey: current.serviceKey,
        });
        setRerouteBySignalId((prev) => ({ ...prev, [signal.id]: response }));
      } catch {
        setRerouteBySignalId((prev) => ({ ...prev, [signal.id]: 'error' }));
      }
    },
    [expandedRerouteSignalId, rerouteBySignalId, position]
  );

  const handlePostStatement = useCallback(
    async (signal: RoadSignal) => {
      const current = accountRef.current;
      const body = (draftStatementBySignalId[signal.id] ?? '').trim();
      if (!current || !body || postingSignalId) return;
      if (typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') return;

      setPostingSignalId(signal.id);
      try {
        const response = await postRoadAlertsStatement({
          email: current.email,
          serviceKey: current.serviceKey,
          body,
          latitude: signal.latitude,
          longitude: signal.longitude,
          roadway: signal.roadway ?? undefined,
        });
        setTopicBySignalId((prev) => {
          const existing = prev[signal.id];
          const topic =
            existing && existing !== 'loading' && existing !== 'error' && existing.topic
              ? existing.topic
              : {
                  id: response.topicId,
                  tlid: null,
                  latitude: signal.latitude as number,
                  longitude: signal.longitude as number,
                  roadway: signal.roadway ?? null,
                  createdAt: response.statement.createdAt,
                };
          const priorStatements =
            existing && existing !== 'loading' && existing !== 'error' ? existing.statements : [];
          return {
            ...prev,
            [signal.id]: {
              topic,
              statements: [
                ...priorStatements,
                {
                  id: response.statement.id,
                  username: response.statement.username,
                  body: response.statement.body,
                  createdAt: response.statement.createdAt,
                  replies: [],
                },
              ],
            },
          };
        });
        setDraftStatementBySignalId((prev) => ({ ...prev, [signal.id]: '' }));
      } catch {
        // Leave the draft in place on failure so the driver doesn't lose
        // what they typed/dictated and can just press Post again.
      } finally {
        setPostingSignalId(null);
      }
    },
    [draftStatementBySignalId, postingSignalId]
  );

  const handlePostReply = useCallback(
    async (signal: RoadSignal, parentStatementId: number) => {
      const current = accountRef.current;
      const body = draftReplyText.trim();
      if (!current || !body || postingSignalId) return;

      setPostingSignalId(signal.id);
      try {
        const response = await postRoadAlertsStatement({
          email: current.email,
          serviceKey: current.serviceKey,
          body,
          parentStatementId,
        });
        setTopicBySignalId((prev) => {
          const existing = prev[signal.id];
          if (!existing || existing === 'loading' || existing === 'error') return prev;
          return {
            ...prev,
            [signal.id]: {
              ...existing,
              statements: existing.statements.map((statement) =>
                statement.id === parentStatementId
                  ? {
                      ...statement,
                      replies: [
                        ...statement.replies,
                        {
                          id: response.statement.id,
                          username: response.statement.username,
                          body: response.statement.body,
                          createdAt: response.statement.createdAt,
                          replies: [],
                        },
                      ],
                    }
                  : statement
              ),
            },
          };
        });
        setDraftReplyText('');
        setReplyingToStatementId(null);
      } catch {
        // Leave the draft in place on failure, same reasoning as
        // handlePostStatement above.
      } finally {
        setPostingSignalId(null);
      }
    },
    [draftReplyText, postingSignalId]
  );

  // Shared voice-capture for both the top-level composer and a reply
  // composer -- takes the raw transcript directly as the draft text (no
  // trigger-phrase matching, unlike the save command above: this is
  // freeform dictation, not a fixed command), populating the draft for
  // the driver to review before pressing Post rather than auto-posting
  // public content the way "save" auto-emails.
  const handleListenForComment = useCallback(
    async (signal: RoadSignal, onTranscript: (transcript: string) => void) => {
      if (voiceListeningSignalId || voiceListeningStatementSignalId) return;

      setVoiceListeningStatementSignalId(signal.id);
      setVoiceStatementStatusBySignalId((prev) => ({ ...prev, [signal.id]: 'Listening…' }));
      try {
        const transcript = await listenOnce();
        if (!transcript) {
          setVoiceStatementStatusBySignalId((prev) => ({ ...prev, [signal.id]: "Didn't catch anything." }));
          return;
        }
        onTranscript(transcript);
        setVoiceStatementStatusBySignalId((prev) => ({ ...prev, [signal.id]: '' }));
      } catch {
        setVoiceStatementStatusBySignalId((prev) => ({ ...prev, [signal.id]: 'Could not check the microphone.' }));
      } finally {
        setVoiceListeningStatementSignalId(null);
      }
    },
    [voiceListeningSignalId, voiceListeningStatementSignalId]
  );

  // Alerting only runs while this screen is mounted -- App.tsx's tab bar
  // fully unmounts every screen on tab switch (no router, no background
  // task), so stopping here on unmount is both necessary (leaking a
  // location watch would drain battery for no visible UI) and a real
  // limitation worth knowing about: switching tabs silently stops alerts.
  useEffect(() => {
    return () => {
      subscriptionRef.current?.remove();
      Speech.stop();
    };
  }, []);

  if (account === undefined) {
    return null;
  }

  if (account === null) {
    return <RoadAlertsRegistration onRegistered={setAccount} reason={registrationReason} />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <Icon name="roadAlerts" size={24} color={colors.accent} />
        <Text style={styles.title}>Road alerts</Text>
      </View>
      <Text style={styles.subtitle}>
        Live traffic hazards near you, spoken aloud as you approach them.
      </Text>

      <View style={styles.spacingSmall}>
        <ThemedButton
          title={settingsOpen ? 'Hide settings' : 'Settings'}
          onPress={() => setSettingsOpen((o) => !o)}
          variant="ghost"
        />
      </View>

      {settingsOpen && (
        <>
      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          Traffic data from New England 511 (Maine, New Hampshire, and Vermont DOTs). Provided
          as-is, with no accuracy or uptime guarantee. Your location is sent for one live check at
          a time and isn't stored -- this is the first slice of a larger design (see
          docs/ROAD_ALERTS_DESIGN.md): only live traffic hazards near your current position and
          heading, not yet weather, events, or your own routine streets.
        </Text>
      </View>

      <View style={styles.noteCard}>
        <Text style={styles.noteText}>
          Registered as {account.email}. Road Alerts is free while we're testing it -- no payment
          required, and we'll let you know before that ever changes.
        </Text>
        <Text style={styles.noteText}>
          Daily email digest: recaps alerts you explicitly save while driving (the "save"/"keep"/
          "email" voice command) -- not everything spoken aloud along the way. When on, a saved
          alert (roadway, severity, a short description) is kept only until it's included in that
          day's digest email, then deleted.
        </Text>
        <View style={styles.spacingSmall}>
          <ThemedButton
            title={digestOptIn ? 'Daily email digest: On' : 'Daily email digest: Off'}
            onPress={handleToggleDigest}
            variant={digestOptIn ? 'primary' : 'secondary'}
            loading={digestOptInSaving}
          />
        </View>
        {username ? (
          <Text style={[styles.noteText, styles.spacingSmall]}>Posting as {username}.</Text>
        ) : (
          username !== undefined && (
            <View style={styles.spacingSmall}>
              <Text style={styles.noteText}>
                Set a display name before posting a comment on a road alert -- shown instead of your
                email address.
              </Text>
              <View style={[styles.spacingSmall, styles.optionRow]}>
                <TextInput
                  style={styles.textInput}
                  placeholder="Display name"
                  placeholderTextColor={colors.text}
                  value={usernameDraft}
                  onChangeText={setUsernameDraft}
                  autoCapitalize="words"
                  maxLength={40}
                />
                <ThemedButton
                  title="Save"
                  onPress={handleSaveUsername}
                  variant="secondary"
                  loading={usernameSaving}
                />
              </View>
            </View>
          )
        )}
        <View style={styles.spacingSmall}>
          <ThemedButton title="Not you? Use a different email" onPress={handleUseDifferentEmail} variant="ghost" />
        </View>
      </View>

      <Text style={styles.label}>Spoken detail level</Text>
      <View style={styles.optionRow}>
        {DETAIL_OPTIONS.map((opt) => (
          <View key={opt.value} style={styles.optionButton}>
            <ThemedButton
              title={opt.label}
              onPress={() => setDetailLevel(opt.value)}
              variant={detailLevel === opt.value ? 'primary' : 'secondary'}
              block
            />
          </View>
        ))}
      </View>

      <View style={styles.buttonRow}>
        <View style={styles.buttonSpacer}>
          <ThemedButton
            title={voiceEnabled ? 'Voice: On' : 'Voice: Muted'}
            onPress={() => setVoiceEnabled((v) => !v)}
            variant="secondary"
            block
          />
        </View>
        <View style={styles.buttonSpacer}>
          <ThemedButton
            title={watching ? 'Stop' : 'Start'}
            onPress={watching ? handleStop : handleStart}
            variant={watching ? 'secondary' : 'primary'}
            block
          />
        </View>
      </View>

      <Text style={styles.cardMeta}>
        {position
          ? `Watching near ${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}`
          : watching
            ? 'Waiting for a GPS fix…'
            : 'Not watching your location yet.'}
      </Text>

      <View style={styles.noteCard}>
        <Text style={styles.label}>Test a location manually</Text>
        <Text style={[styles.noteText, styles.spacingSmall]}>
          Type coordinates instead of using GPS -- useful to check a spot you can't actually
          drive to right now (e.g. approaching a fake weighted point you added for testing).
        </Text>
        <View style={[styles.spacingSmall, styles.optionRow]}>
          <TextInput
            style={styles.textInput}
            placeholder="Latitude"
            placeholderTextColor={colors.text}
            value={manualLatitude}
            onChangeText={setManualLatitude}
            keyboardType="default"
            autoCapitalize="none"
          />
          <TextInput
            style={styles.textInput}
            placeholder="Longitude"
            placeholderTextColor={colors.text}
            value={manualLongitude}
            onChangeText={setManualLongitude}
            keyboardType="default"
            autoCapitalize="none"
          />
        </View>
        <TextInput
          style={[styles.textInput, styles.spacingSmall]}
          placeholder="Heading in degrees, optional -- blank means 'assume ahead'"
          placeholderTextColor={colors.text}
          value={manualHeading}
          onChangeText={setManualHeading}
          keyboardType="default"
          autoCapitalize="none"
        />
        <View style={styles.spacingSmall}>
          <ThemedButton
            title={manualChecking ? 'Checking…' : 'Check this location'}
            onPress={handleManualCheck}
            variant="primary"
            block
          />
        </View>
      </View>
        </>
      )}

      {error && <Text style={[styles.spacing, styles.errorText]}>{error}</Text>}
      {!error && partial && (
        <Text style={[styles.spacing, styles.cardMeta]}>
          One or more 511 networks are temporarily unavailable -- showing partial results.
        </Text>
      )}

      <View style={styles.spacing}>
        <Text style={styles.cardTitle}>
          {signals.length} alert{signals.length === 1 ? '' : 's'} within {metersLabel(RADIUS_METERS)}
        </Text>
        {signals.map((signal, index) => {
          const onRoute = onRouteIds.has(signal.id);
          const ahead =
            onRoute ||
            (position && typeof signal.latitude === 'number' && typeof signal.longitude === 'number'
              ? isAhead(
                  position.heading,
                  bearingDegrees({ latitude: position.latitude, longitude: position.longitude }, {
                    latitude: signal.latitude,
                    longitude: signal.longitude,
                  })
                )
              : true);
          const distance =
            position && typeof signal.latitude === 'number' && typeof signal.longitude === 'number'
              ? haversineDistanceMeters({ latitude: position.latitude, longitude: position.longitude }, {
                  latitude: signal.latitude,
                  longitude: signal.longitude,
                })
              : null;

          return (
            <View
              key={signal.id}
              style={[styles.resultCard, index === 0 ? { backgroundColor: colors.accent100 } : null]}
            >
              <View style={[styles.resultHeader, { alignItems: 'flex-start' }]}>
                <Text style={styles.cardKicker}>
                  {distance !== null ? `${metersLabel(distance)} away` : 'distance unknown'}
                  {onRoute ? ' · on your route' : !ahead ? ' · behind you' : ''}
                </Text>
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <View style={[styles.severityTag, { borderColor: SEVERITY_COLORS[signal.severity] }]}>
                    <Text style={[styles.severityTagText, { color: SEVERITY_COLORS[signal.severity] }]}>
                      {SEVERITY_LABELS[signal.severity]}
                    </Text>
                  </View>
                  <Text style={styles.cardKicker}>{freshnessLabel(signal)}</Text>
                </View>
              </View>
              <Text style={styles.resultAddress}>
                <Text accessibilityLabel={HAZARD_CATEGORY_LABELS[signal.hazardCategory]}>
                  {HAZARD_CATEGORY_ICONS[signal.hazardCategory]}{' '}
                </Text>
                {signal.roadway ?? 'Unknown road'}
                {signal.direction ? ` (${signal.direction})` : ''}
              </Text>
              <Text style={styles.bodyText}>{signal.speech[detailLevel]}</Text>
              <View style={[styles.buttonRowWide, styles.optionRow]}>
                <ThemedButton title="Speak" onPress={() => speakSignal(signal)} variant="ghost" />
                {speechRecognitionAvailable && (
                  <ThemedButton
                    title={voiceListeningSignalId === signal.id ? 'Listening…' : '🎤 Say "save this"'}
                    onPress={() => handleListenForSaveCommand(signal)}
                    variant="ghost"
                  />
                )}
                <ThemedButton
                  title={expandedSignalId === signal.id ? 'Hide comments' : 'Comments'}
                  onPress={() => handleToggleComments(signal)}
                  variant="ghost"
                />
                {position && typeof signal.latitude === 'number' && typeof signal.longitude === 'number' && (
                  <>
                    <ThemedButton
                      title={mapOpenSignalId === signal.id ? 'Hide map' : 'Show on map'}
                      onPress={() => handleToggleMap(signal)}
                      variant="ghost"
                    />
                    <ThemedButton
                      title={expandedRerouteSignalId === signal.id ? 'Hide route options' : 'Show a way around this'}
                      onPress={() => handleToggleReroute(signal)}
                      variant="ghost"
                    />
                  </>
                )}
              </View>
              {voiceStatusBySignalId[signal.id] && (
                <Text style={styles.cardMeta}>{voiceStatusBySignalId[signal.id]}</Text>
              )}
              {mapOpenSignalId === signal.id &&
                position &&
                typeof signal.latitude === 'number' &&
                typeof signal.longitude === 'number' &&
                (() => {
                  const rerouteState = rerouteBySignalId[signal.id];
                  const rerouteReady =
                    rerouteState && rerouteState !== 'loading' && rerouteState !== 'error' ? rerouteState : null;
                  return (
                    <>
                      {expandedRerouteSignalId === signal.id && rerouteState === 'loading' && (
                        <Text style={styles.cardMeta}>Finding a way around…</Text>
                      )}
                      {expandedRerouteSignalId === signal.id && rerouteState === 'error' && (
                        <Text style={styles.cardMeta}>Could not find a way around this hazard.</Text>
                      )}
                      {expandedRerouteSignalId === signal.id &&
                        rerouteReady &&
                        rerouteReady.options.length === 0 && (
                          <Text style={styles.cardMeta}>No route around this hazard was found.</Text>
                        )}
                      <RoadAlertsMap
                        driverPosition={{ latitude: position.latitude, longitude: position.longitude }}
                        hazardPosition={{ latitude: signal.latitude, longitude: signal.longitude }}
                        rejoinPoint={rerouteReady?.rejoinPoint}
                        options={rerouteReady?.options}
                        highlightedIndex={highlightedRouteIndex}
                      />
                      {rerouteReady?.options.map((option, index) => (
                        <Pressable
                          key={index}
                          onPress={() =>
                            setHighlightedRouteIndex((current) => (current === index ? null : index))
                          }
                          style={[
                            styles.optionRow,
                            styles.spacingSmall,
                            styles.optionRowTappable,
                            highlightedRouteIndex === index ? styles.optionRowHighlighted : null,
                          ]}
                        >
                          <View style={styles.optionRowLabel}>
                            <View
                              style={[styles.routeSwatch, { backgroundColor: ROUTE_COLORS[index % ROUTE_COLORS.length] }]}
                            />
                            <Text style={styles.cardMeta}>
                              Option {index + 1}:{' '}
                              {option.distanceMeters !== null ? metersLabel(option.distanceMeters) : '?'}
                              {option.durationSeconds !== null
                                ? `, ~${Math.round(option.durationSeconds / 60)} min`
                                : ''}
                            </Text>
                          </View>
                          <ThemedButton
                            title="Navigate with Google Maps"
                            variant="ghost"
                            onPress={() =>
                              Linking.openURL(
                                buildGoogleMapsDirectionsUrl(
                                  { latitude: position.latitude, longitude: position.longitude },
                                  rerouteReady.rejoinPoint,
                                  option
                                )
                              )
                            }
                          />
                        </Pressable>
                      ))}
                    </>
                  );
                })()}
              {expandedSignalId === signal.id && (
                <View style={styles.commentsPanel}>
                  {(() => {
                    const topicState = topicBySignalId[signal.id];
                    if (topicState === 'loading') {
                      return <Text style={styles.cardMeta}>Loading comments…</Text>;
                    }
                    if (topicState === 'error') {
                      return <Text style={styles.cardMeta}>Could not load comments.</Text>;
                    }
                    const statements = topicState?.statements ?? [];
                    return (
                      <>
                        {statements.length === 0 && (
                          <Text style={styles.cardMeta}>No comments here yet.</Text>
                        )}
                        {statements.map((statement) => (
                          <View key={statement.id} style={styles.spacingSmall}>
                            <Text style={styles.cardMeta}>
                              {statement.username} · {new Date(statement.createdAt).toLocaleString()}
                            </Text>
                            <Text style={styles.bodyText}>{statement.body}</Text>
                            {statement.replies.map((reply) => (
                              <View key={reply.id} style={styles.replyIndent}>
                                <Text style={styles.cardMeta}>
                                  {reply.username} · {new Date(reply.createdAt).toLocaleString()}
                                </Text>
                                <Text style={styles.bodyText}>{reply.body}</Text>
                              </View>
                            ))}
                            {username &&
                              (replyingToStatementId === statement.id ? (
                                <View style={styles.spacingSmall}>
                                  <View style={styles.optionRow}>
                                    <TextInput
                                      style={styles.textInput}
                                      placeholder="Reply"
                                      placeholderTextColor={colors.text}
                                      value={draftReplyText}
                                      onChangeText={setDraftReplyText}
                                    />
                                    {speechRecognitionAvailable && (
                                      <ThemedButton
                                        title={
                                          voiceListeningStatementSignalId === signal.id ? 'Listening…' : '🎤'
                                        }
                                        onPress={() => handleListenForComment(signal, setDraftReplyText)}
                                        variant="ghost"
                                      />
                                    )}
                                  </View>
                                  <View style={styles.optionRow}>
                                    <ThemedButton
                                      title="Post reply"
                                      onPress={() => handlePostReply(signal, statement.id)}
                                      variant="primary"
                                      loading={postingSignalId === signal.id}
                                    />
                                    <ThemedButton
                                      title="Cancel"
                                      onPress={() => setReplyingToStatementId(null)}
                                      variant="ghost"
                                    />
                                  </View>
                                </View>
                              ) : (
                                <ThemedButton
                                  title="Reply"
                                  onPress={() => setReplyingToStatementId(statement.id)}
                                  variant="ghost"
                                />
                              ))}
                          </View>
                        ))}
                        {username ? (
                          <View style={styles.spacingSmall}>
                            <View style={styles.optionRow}>
                              <TextInput
                                style={styles.textInput}
                                placeholder="Add a comment"
                                placeholderTextColor={colors.text}
                                value={draftStatementBySignalId[signal.id] ?? ''}
                                onChangeText={(text) =>
                                  setDraftStatementBySignalId((prev) => ({ ...prev, [signal.id]: text }))
                                }
                              />
                              {speechRecognitionAvailable && (
                                <ThemedButton
                                  title={voiceListeningStatementSignalId === signal.id ? 'Listening…' : '🎤'}
                                  onPress={() =>
                                    handleListenForComment(signal, (transcript) =>
                                      setDraftStatementBySignalId((prev) => ({ ...prev, [signal.id]: transcript }))
                                    )
                                  }
                                  variant="ghost"
                                />
                              )}
                            </View>
                            <ThemedButton
                              title="Post"
                              onPress={() => handlePostStatement(signal)}
                              variant="primary"
                              loading={postingSignalId === signal.id}
                            />
                            {voiceStatementStatusBySignalId[signal.id] && (
                              <Text style={styles.cardMeta}>{voiceStatementStatusBySignalId[signal.id]}</Text>
                            )}
                          </View>
                        ) : (
                          <Text style={styles.cardMeta}>Set a display name above to post a comment.</Text>
                        )}
                      </>
                    );
                  })()}
                </View>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    padding: space[4],
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    marginBottom: 4,
  },
  title: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 30,
    color: colors.text,
  },
  subtitle: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    opacity: 0.7,
    marginBottom: space[4],
  },
  noteCard: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: space[3],
    marginBottom: space[6],
  },
  noteText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  label: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
    opacity: 0.7,
    marginBottom: 5,
  },
  optionRow: {
    flexDirection: 'row',
    gap: space[2],
    marginBottom: space[3],
  },
  optionButton: {
    flex: 1,
  },
  optionRowTappable: {
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space[1],
    borderRadius: radius.sm,
  },
  optionRowHighlighted: {
    backgroundColor: colors.surface,
  },
  optionRowLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
  },
  routeSwatch: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.sm,
    paddingHorizontal: space[2],
    paddingVertical: space[2],
    fontFamily: 'Lora_400Regular',
    fontSize: 14,
    color: colors.text,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: space[2],
    marginTop: space[3],
  },
  buttonSpacer: {
    flex: 1,
  },
  spacing: {
    marginTop: space[4],
  },
  spacingSmall: {
    marginTop: space[1],
    alignItems: 'flex-start',
  },
  cardTitle: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 17,
    color: colors.text,
    marginBottom: space[2],
  },
  cardMeta: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
    opacity: 0.65,
  },
  resultCard: {
    marginTop: space[3],
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    padding: space[3],
  },
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  cardKicker: {
    fontFamily: 'Lora_400Regular',
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.accent,
  },
  severityTag: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  severityTagText: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 13,
  },
  resultAddress: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 17,
    color: colors.text,
    marginBottom: space[2],
  },
  buttonRowWide: {
    marginTop: space[4],
    alignItems: 'flex-start',
  },
  bodyText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    marginTop: 4,
  },
  errorText: {
    fontFamily: 'Lora_400Regular',
    color: colors.errorText,
  },
  commentsPanel: {
    marginTop: space[3],
    paddingTop: space[3],
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  replyIndent: {
    marginLeft: space[3],
    marginTop: space[1],
  },
});
