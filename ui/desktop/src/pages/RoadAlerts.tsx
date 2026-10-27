import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';

import {
  ApiError,
  deleteRoadAlertsLivePosition,
  emailRoadAlert,
  getRoadAlertsCrossStreet,
  getRoadAlertsPreferences,
  getRoadAlertsPushPublicKey,
  getRoadAlertsTopic,
  getRoadAlertsUsername,
  getRoadReroute,
  getRoadSignals,
  getTestWeightedPoints,
  getWeightedPoints,
  markRoadAlertsNotificationsViewed,
  postRoadAlertsLivePosition,
  postRoadAlertsStatement,
  postWeightedPointPing,
  subscribeRoadAlertsPush,
  updateRoadAlertsPreferences,
  updateRoadAlertsUsername,
} from '../../../shared/api/client';
import type {
  CrossStreetResponse,
  RoadAlertsRoutineDensity,
  RoadAlertsTopicResponse,
  RerouteOption,
  RoadRerouteResponse,
  RoadSignal,
  RoadSignalSeverity,
} from '../../../shared/api/types';
import { bearingDegrees, estimateSpeedMetersPerSecond, haversineDistanceMeters, isAhead } from '../../../shared/geo';
import type { TimedCoordinates } from '../../../shared/geo';
import {
  approachedWeightedPoints,
  findAlertsForWeightedPoints,
  shouldStronglyAlert,
  type WeightedPoint,
} from '../../../shared/roadAlertsMatching';
import {
  buildDrivePlan,
  positionAlongRoute,
  routeAheadOf,
  routeOverlap,
  type DrivePlan,
} from '../../../shared/driveSimulation';
import { buildGoogleMapsDirectionsUrl } from '../../../shared/googleMapsDirections';
import { HAZARD_CATEGORY_ICONS, HAZARD_CATEGORY_LABELS } from '../../../shared/hazardCategories';
import AlertSketch from '../components/AlertSketch';
import PageHeader from '../components/PageHeader';
import { rerouteErrorMessage } from '../rerouteErrorMessage';
import RoadAlertsRegistration from '../components/RoadAlertsRegistration';
import RoadAlertsSandboxMap, { type SandboxPoint } from '../components/RoadAlertsSandboxMap';
import RoadAlertsTabs from '../components/RoadAlertsTabs';
import RoadRerouteMap, { ROUTE_COLORS } from '../components/RoadRerouteMap';
import {
  isPushCapable,
  playAlertChime,
  requestNotificationPermission,
  showAlertNotification,
  subscribeToPush,
} from '../roadAlertNotifications';
import { clearStoredAccount, getStoredAccount, type StoredRoadAlertsAccount } from '../roadAlertsStorage';
import { isSpeechRecognitionAvailable, listenOnce, matchesSaveCommand } from '../webSpeechRecognition';

type DetailLevel = 'brief' | 'average' | 'deep';

const DETAIL_OPTIONS: { label: string; value: DetailLevel }[] = [
  { label: 'Brief', value: 'brief' },
  { label: 'Average', value: 'average' },
  { label: 'Deep', value: 'deep' },
];

// Copy verbatim from docs/ROAD_ALERTS_DESIGN.md's "User-facing setting:
// how much routine is remembered" table -- drafted alongside the design,
// reused here rather than rewritten.
const ROUTINE_DENSITY_OPTIONS: { label: string; value: RoadAlertsRoutineDensity; description: string }[] = [
  {
    label: 'Minimal',
    value: 'minimal',
    description:
      'Only streets driven almost every time are remembered. Fewest streets stored, strongest privacy -- may miss alerts on routes driven less often.',
  },
  {
    label: 'Balanced',
    value: 'balanced',
    description: 'Streets driven regularly, not just constantly.',
  },
  {
    label: 'Most complete',
    value: 'most_complete',
    description:
      'Includes streets driven only occasionally. Most complete alert coverage, at the cost of remembering more of your driving habits.',
  },
];

const RADIUS_METERS = 10000;
// Ties polling to real movement (the watch callback firing again) rather
// than a separate timer, but still caps how often the free public 511
// API gets hit if the browser reports position rapidly.
const POLL_MIN_INTERVAL_MS = 15000;
// Mirrors ui/mobile's RoadAlertsForm.tsx exactly -- see that file's own
// comment for why this is much coarser than POLL_MIN_INTERVAL_MS.
const WEIGHTED_POINT_PING_INTERVAL_MS = 3 * 60 * 1000;
// Watching auto-starts as soon as an account is ready (see the effect
// below) -- someone who just opened this page while parked shouldn't see
// a hazard list for wherever they happen to be sitting. "Hazards in the
// Neighborhood" already covers that passive/not-driving case; this tab
// only starts checking once real movement is detected. ~7.8 mph: safely
// above GPS jitter and a brisk walk/jog (which could otherwise trip this
// while carrying the phone), comfortably below the slowest realistic
// driving speed (a car easing out of a driveway).
const MOVING_SPEED_THRESHOLD_MPS = 3.5;
// Below this distance between two consecutive GPS fixes, ordinary jitter
// dominates -- neither the speed nor the bearing computed between them is
// trustworthy. 15m comfortably exceeds typical enableHighAccuracy jitter
// (commonly 5-15m outdoors) while still being covered in ~2s at even a
// slow-moving car's speed, so real movement is still detected promptly.
const MIN_RELIABLE_DISPLACEMENT_METERS = 15;
// How many recent position samples the in-memory route-approach trail
// keeps -- ~60 seconds at the existing ~15s hazard-check cadence. Short
// on purpose: a real route change (a turn) should outweigh the pre-turn
// direction quickly, not stay diluted by many minutes of stale samples.
// Never persisted anywhere -- see docs/ROAD_ALERTS_DESIGN.md's Privacy
// model section.
const TRAIL_MAX_SAMPLES = 4;
// The route actually driven since Start, for the alert sketches (cards and
// notifications) -- separate from the short matching trail above, which
// must stay short. A point is kept every this many meters...
const DRIVEN_PATH_STEP_METERS = 15;
// ...and past this many points every other one is dropped (the shape
// survives; ~30 km at 15 m spacing before the first thinning).
const DRIVEN_PATH_MAX_POINTS = 2000;

const SEVERITY_LABELS: Record<RoadSignalSeverity, string> = {
  serious: 'Serious',
  need_to_know: 'Need to know',
  proximity: 'Proximity',
  fun_to_know: 'Fun to know',
};

// Reuses the app's existing tag classes (styles.css) rather than
// inventing new severity-specific colors.
const SEVERITY_TAG_CLASS: Record<RoadSignalSeverity, string> = {
  serious: 'tag-danger',
  need_to_know: 'tag-accent',
  proximity: 'tag-accent-2',
  fun_to_know: 'tag-neutral',
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

// Alerts speak automatically at every tier except fun_to_know -- manual
// replay via each row's Speak button is the only way a fun_to_know item
// is ever heard.
function shouldAutoSpeak(severity: RoadSignalSeverity): boolean {
  return severity !== 'fun_to_know';
}

type AlarmTestCoords = { latitude: number; longitude: number; heading: number | null };

// Router state RoadAlertsSandbox.tsx's "Simulate a drive" panel sends --
// a street route (GeoJSON [lon, lat] pairs) to replay as fake GPS fixes
// in place of navigator.geolocation, at speedMps of route distance per
// real second (already multiplied by any fast-forward factor).
export type SimulatedDriveState = {
  coordinates: [number, number][];
  speedMps: number;
  label: string;
};

// How often a simulated drive emits a fake fix -- about what a real
// phone's watchPosition delivers while driving.
const SIMULATED_FIX_INTERVAL_MS = 1000;

export default function RoadAlerts() {
  const location = useLocation();
  const [account, setAccount] = useState<StoredRoadAlertsAccount | null>(() => getStoredAccount());
  const [registrationReason, setRegistrationReason] = useState<string | null>(null);
  // Captured once on mount, same "never re-read on a later re-render" trick
  // Batch.tsx uses for its own forwarded-file router state -- see
  // RoadAlertsAlarmTest.tsx, the sender. A plain revisit to /road-alerts
  // (no state) or a remount later in the session won't re-trigger this.
  const [pendingAlarmTest] = useState<AlarmTestCoords | null>(
    () => (location.state as { alarmTestCoords?: AlarmTestCoords } | null)?.alarmTestCoords ?? null
  );
  const alarmTestRanRef = useRef(false);
  // Same capture-once-on-mount trick as pendingAlarmTest. Non-null for as
  // long as a simulated drive is still to be (or being) driven; cleared
  // once it finishes or is stopped, so a later Start uses real GPS again.
  const [simulatedDriveInit] = useState<{ plan: DrivePlan; speedMps: number; label: string } | null>(() => {
    const state = (location.state as { simulatedDrive?: SimulatedDriveState } | null)?.simulatedDrive;
    if (!state) return null;
    try {
      return { plan: buildDrivePlan(state.coordinates), speedMps: state.speedMps, label: state.label };
    } catch {
      return null;
    }
  });
  const simulatedDriveRef = useRef(simulatedDriveInit);
  const simulationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // True only while fixes are coming from a simulated drive rather than
  // real GPS -- read by onPosition so a fake fix is never reported as a
  // real weighted-point ping (that would pollute the account's real
  // routine-route model with a drive that never happened).
  const simulatingRef = useRef(false);
  const [simulationProgress, setSimulationProgress] = useState<{
    label: string;
    distanceMeters: number;
    totalMeters: number;
    done: boolean;
  } | null>(null);

  // The simulated drive's route as GeoJSON [lon, lat] pairs, drawn on the
  // map for as long as the progress banner shows (cleared only when the
  // page unmounts), plus whether the map keeps the car centred.
  const [simulatedRoute, setSimulatedRoute] = useState<[number, number][] | null>(null);
  const [followCar, setFollowCar] = useState(true);
  const [watching, setWatching] = useState(false);
  const [position, setPosition] = useState<{ latitude: number; longitude: number; heading: number | null } | null>(
    null
  );
  // True once a GPS fix shows real movement (see MOVING_SPEED_THRESHOLD_MPS)
  // since the last Start press -- hazard checks are held back until then
  // (see onPosition below), so opening this page while parked doesn't
  // surface a hazard list for a stationary location.
  const [hasDetectedMovement, setHasDetectedMovement] = useState(false);
  const [signals, setSignals] = useState<RoadSignal[]>([]);
  // Signal ids findAlertsForWeightedPoints (narrowed by
  // approachedWeightedPoints) most recently matched -- drives both the
  // auto-speak "ahead" override and the "on your route" list tag below.
  const [onRouteIds, setOnRouteIds] = useState<Set<string>>(new Set());
  // The hazard whose chime/notification just fired, if any -- lets the list
  // below highlight exactly which card triggered the alert the driver just
  // heard, rather than making them scan the whole list to find it.
  const [alertedSignalId, setAlertedSignalId] = useState<string | null>(null);
  // Which alert's card was clicked -- drives the map's focusPoint below
  // (and the reverse: clicking a map marker drives this and scrolls the
  // matching card into view). Same pattern as RoadAlertsHomeBoard.tsx's
  // own selectedSignalId/RoadAlertsSandboxMap pairing.
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const mapContainerRef = useRef<HTMLDivElement>(null);
  // Spoken alerts default to the shortest form -- something you hear
  // while approaching a hazard should be as small as possible.
  const [detailLevel, setDetailLevel] = useState<DetailLevel>('brief');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [digestOptIn, setDigestOptIn] = useState(false);
  const [digestOptInSaving, setDigestOptInSaving] = useState(false);
  const [routineDensity, setRoutineDensity] = useState<RoadAlertsRoutineDensity>('balanced');
  const [routineDensitySaving, setRoutineDensitySaving] = useState(false);
  // null = fetched, not set yet; undefined = not fetched yet.
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);
  // The alert list is the primary thing to see here -- registration,
  // digest/username, spoken-detail level, and manual test coordinates are
  // setup/testing concerns that shouldn't sit between opening this page and
  // seeing what's nearby. Collapsed by default; watching now starts on its
  // own (see the auto-start effect below) instead of waiting on a press.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // "Save this" voice command per alert row -- keyed by signal id so each
  // row shows its own status; voiceListeningSignalId gates against
  // starting a second mic session while one's already listening.
  const [voiceListeningSignalId, setVoiceListeningSignalId] = useState<string | null>(null);
  const [voiceStatusBySignalId, setVoiceStatusBySignalId] = useState<Record<string, string>>({});
  const speechRecognitionAvailable = useMemo(() => isSpeechRecognitionAvailable(), []);

  // Comments on a road topic -- one panel open at a time.
  const [expandedSignalId, setExpandedSignalId] = useState<string | null>(null);
  const [topicBySignalId, setTopicBySignalId] = useState<
    Record<string, RoadAlertsTopicResponse | 'loading' | 'error'>
  >({});
  const [draftStatementBySignalId, setDraftStatementBySignalId] = useState<Record<string, string>>({});
  const [replyingToStatementId, setReplyingToStatementId] = useState<number | null>(null);
  const [draftReplyText, setDraftReplyText] = useState('');
  const [postingSignalId, setPostingSignalId] = useState<string | null>(null);
  const [voiceListeningStatementSignalId, setVoiceListeningStatementSignalId] = useState<string | null>(null);
  const [voiceStatementStatusBySignalId, setVoiceStatementStatusBySignalId] = useState<Record<string, string>>({});

  // Auto-fetched, no button -- a cheap (existing `streets` table, no
  // external API) hint of the nearest street to turn onto right now,
  // shown for any signal that's ahead once a position is known. 'none'
  // means fetched but nothing qualified (a 404/422 from the server, e.g.
  // no candidate street nearby) -- distinct from not-yet-fetched
  // (absent from the map) so it isn't retried every render.
  const [crossStreetBySignalId, setCrossStreetBySignalId] = useState<
    Record<string, CrossStreetResponse | 'loading' | 'none'>
  >({});
  const crossStreetFetchedRef = useRef<Set<string>>(new Set());

  // The fuller, on-demand detour: 1-2 routed alternatives past the
  // hazard from an external routing service. One panel open at a time,
  // same as the comments panel above.
  const [expandedRerouteSignalId, setExpandedRerouteSignalId] = useState<string | null>(null);
  const [rerouteBySignalId, setRerouteBySignalId] = useState<
    Record<string, RoadRerouteResponse | 'loading' | { error: string }>
  >({});
  // Which option row is currently hovered, so RoadRerouteMap can call out
  // the matching route -- only one reroute panel is ever open at once
  // (expandedRerouteSignalId), so this doesn't need to be keyed per signal.
  const [hoveredRouteIndex, setHoveredRouteIndex] = useState<number | null>(null);

  // Typed coordinates in place of real GPS -- a desktop has no real
  // location to drive around, so this is the primary way to actually see
  // the feature work here, not just a testing aid the way it is on mobile.
  const [manualLatitude, setManualLatitude] = useState('');
  const [manualLongitude, setManualLongitude] = useState('');
  const [manualHeading, setManualHeading] = useState('');
  const [manualChecking, setManualChecking] = useState(false);

  const watchIdRef = useRef<number | null>(null);
  const lastFetchAtRef = useRef(0);
  const spokenIdsRef = useRef<Set<string>>(new Set());
  const voiceEnabledRef = useRef(voiceEnabled);
  const detailLevelRef = useRef(detailLevel);
  const accountRef = useRef(account);
  // Throttles weighted-point pings independently of lastFetchAtRef's
  // (much tighter) hazard-check throttle -- see WEIGHTED_POINT_PING_INTERVAL_MS.
  const lastWeightedPingAtRef = useRef(0);
  // True only for the very first position fix after a Start press -- that
  // fix is this trip's origin, reported with isEndpoint so it's never
  // recorded as a weighted point. Reset in handleStart. Mirrors
  // ui/mobile's RoadAlertsForm.tsx exactly.
  const isFirstPositionOfSessionRef = useRef(true);
  // Latest known fix, read from handleStop to report the trip's actual
  // endpoint -- a ref (not just the `position` state) so handleStop
  // doesn't need `position` in its own dependency array.
  const positionRef = useRef<{ latitude: number; longitude: number } | null>(null);
  // Mirrors hasDetectedMovement -- read/written directly inside onPosition
  // (a ref, not the state value, since onPosition is a long-lived
  // useCallback closure registered once with watchPosition; the state
  // setter still runs alongside it, purely to trigger a re-render).
  const hasDetectedMovementRef = useRef(false);
  // True only once the server has actually confirmed this browser's push
  // subscription (i.e. subscribeRoadAlertsPush's POST resolved), not
  // merely once subscribeToPush produced a local PushSubscription object.
  // Gates whether onPosition's GPS-driven polling is allowed to also POST
  // the driver's live position -- see
  // docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md's
  // "Ephemeral live position" section and the privacy addendum in
  // docs/ROAD_ALERTS_DESIGN.md: the live position is sent only when a real
  // push subscription exists, never unconditionally, and never from the
  // manual "Check now" test path (handleManualCheck calls fetchSignals
  // directly, bypassing onPosition entirely). Reset to false in
  // handleStart (before re-subscribing) and in handleStop.
  const pushSubscribedRef = useRef(false);
  // The previous GPS fix, used to estimate speed when the device doesn't
  // report GeolocationCoordinates.speed itself (see onPosition below).
  // Reset in handleStart so a stale fix from a prior trip can't be
  // compared against this trip's first one.
  const lastFixRef = useRef<{ latitude: number; longitude: number; timestampMs: number } | null>(null);
  // Short in-memory trail for approachedWeightedPoints -- capped at
  // TRAIL_MAX_SAMPLES, oldest dropped first. Never persisted. Reset in
  // handleStart, same as lastFixRef.
  const trailRef = useRef<TimedCoordinates[]>([]);
  // Every point actually passed since Start (DRIVEN_PATH_STEP_METERS
  // apart), drawn in the alert sketches so the route driven stays in the
  // picture. Same privacy model as the trail: in this tab only, never sent
  // to the server, discarded on Stop.
  const drivenPathRef = useRef<{ latitude: number; longitude: number }[]>([]);
  const [drivenPath, setDrivenPath] = useState<{ latitude: number; longitude: number }[]>([]);
  // This account's real, already-qualified weighted points -- populated
  // by refreshRealWeightedPoints below. A ref, not state: nothing here
  // renders directly from it, it's only read inside the long-lived
  // fetchSignals closure.
  const weightedPointsRef = useRef<WeightedPoint[]>([]);
  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);
  useEffect(() => {
    detailLevelRef.current = detailLevel;
  }, [detailLevel]);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  // This account's real, already-qualified weighted points, used to
  // narrow (approachedWeightedPoints) and then match
  // (findAlertsForWeightedPoints) hazards against routine destinations --
  // see fetchSignals below. Re-fetched from pingWeightedPoint whenever a
  // new ping might have just pushed a point past its qualifying
  // threshold, so a route that becomes routine *during* this same
  // session is usable without waiting for the next sign-in. Mirrors
  // ui/mobile's RoadAlertsForm.tsx's own refreshRealWeightedPoints.
  const refreshRealWeightedPoints = useCallback(async () => {
    const current = accountRef.current;
    if (!current) return;
    try {
      // Plus any developer-seeded test points (see
      // geocoding-server/src/testWeightedPoints.js), same as ui/mobile's
      // RoadAlertsForm.tsx merges in -- that endpoint 404s unless
      // ALLOW_TEST_WEIGHTED_POINTS is set, which just leaves it empty.
      const [response, testResponse] = await Promise.all([
        getWeightedPoints({ email: current.email, serviceKey: current.serviceKey }),
        getTestWeightedPoints({ email: current.email, serviceKey: current.serviceKey }).catch(() => ({
          weightedPoints: [],
        })),
      ]);
      weightedPointsRef.current = [...response.weightedPoints, ...testResponse.weightedPoints].map((p) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        weight: p.weight,
        tlid: p.tlid ?? undefined,
      }));
    } catch {
      // Best-effort -- see pingWeightedPoint's own comment below.
    }
  }, []);

  // One-shot fetch as soon as an account is ready -- without this, a
  // fresh sign-in would have an empty weightedPointsRef until the first
  // qualifying ping (WEIGHTED_POINT_PING_INTERVAL_MS into a drive).
  useEffect(() => {
    if (!account) {
      weightedPointsRef.current = [];
      return;
    }
    refreshRealWeightedPoints();
  }, [account, refreshRealWeightedPoints]);

  // Reports one GPS ping toward the account's routine-route model (see
  // geocoding-server/src/weightedPoints.js). Fire-and-forget: a failure
  // here is background-enhancement noise, never something that should
  // interrupt or delay hazard alerting. Mirrors ui/mobile's
  // RoadAlertsForm.tsx's pingWeightedPoint exactly.
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

  // Digest opt-in, username, and the notifications-viewed mark are all
  // best-effort, fetch-fresh-on-account-change: a failure just leaves a
  // default value rather than surfacing an error for something this
  // minor.
  useEffect(() => {
    if (!account) {
      setDigestOptIn(false);
      setRoutineDensity('balanced');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await getRoadAlertsPreferences({ email: account.email, serviceKey: account.serviceKey });
        if (!cancelled) {
          setDigestOptIn(response.digestOptIn);
          setRoutineDensity(response.routineDensity);
        }
      } catch {
        if (!cancelled) {
          setDigestOptIn(false);
          setRoutineDensity('balanced');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account]);

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

  useEffect(() => {
    if (!account) return;
    (async () => {
      try {
        await markRoadAlertsNotificationsViewed({ email: account.email, serviceKey: account.serviceKey });
      } catch {
        // best-effort -- see above
      }
    })();
  }, [account]);

  const speakSignal = useCallback((signal: RoadSignal) => {
    if (!voiceEnabledRef.current) return;
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(signal.speech[detailLevelRef.current]));
  }, []);

  const handleStop = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    // A stopped simulated drive is finished for good -- the next Start
    // uses real GPS (go back to the sandbox to drive it again).
    const wasSimulating = simulatingRef.current;
    if (simulationTimerRef.current !== null) {
      clearInterval(simulationTimerRef.current);
      simulationTimerRef.current = null;
    }
    simulatingRef.current = false;
    simulatedDriveRef.current = null;
    window.speechSynthesis?.cancel();
    setWatching(false);

    // Discard the trail and any in-progress route match the moment
    // driving stops -- see docs/ROAD_ALERTS_DESIGN.md's privacy model.
    // Except a simulated drive's driven path: it's a made-up drive, not
    // where anyone really was, so it stays on the map and in the sketches
    // until the next Start -- seeing the whole route taken is the point
    // of the test.
    trailRef.current = [];
    if (!wasSimulating) {
      drivenPathRef.current = [];
      setDrivenPath([]);
    }
    setOnRouteIds(new Set());

    // A Stop-then-Start cycle should re-subscribe cleanly rather than
    // assuming a stale subscription state carries over.
    pushSubscribedRef.current = false;

    // Removes the ephemeral live-position row immediately rather than
    // waiting for the worker's 10-minute staleness timeout.
    const stoppedAccount = accountRef.current;
    if (stoppedAccount) {
      deleteRoadAlertsLivePosition({ email: stoppedAccount.email, serviceKey: stoppedAccount.serviceKey }).catch(() => {
        // Best-effort -- see above.
      });
    }

    // The last known fix is this trip's destination -- reported with
    // isEndpoint so it's never recorded as a weighted point, same
    // reasoning as the origin ping in onPosition below.
    const lastPosition = positionRef.current;
    if (lastPosition && !wasSimulating) {
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

        // Which of this account's routine destinations recent movement
        // actually looks like it's heading toward, then which hazards
        // fall between here and one of those -- see
        // docs/superpowers/specs/2026-09-12-road-alerts-route-approach-design.md.
        // A route match is treated as "ahead" unconditionally below: the
        // corridor-to-a-routine-point geometry already proves relevance,
        // so it shouldn't get silently dropped by a momentary bad heading
        // reading (e.g. stopped at a light) the way a plain cone check
        // would. Mirrors ui/mobile's RoadAlertsForm.tsx exactly.
        const candidatePoints = approachedWeightedPoints(trailRef.current, weightedPointsRef.current);
        const routeAlerts = findAlertsForWeightedPoints({ latitude, longitude }, candidatePoints, response.signals);
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
          // Only mark as handled once it's actually been evaluated as ahead
          // and spoken -- marking it here unconditionally (the previous
          // behavior) meant a hazard seen once while not yet ahead (e.g.
          // heading still noisy right after Start) could never trigger the
          // chime/speech later, even once clearly approached, while it kept
          // showing in the list on every fetch regardless. That mismatch --
          // visible in the list, but permanently silent -- was the bug.
          if (ahead && shouldAutoSpeak(signal.severity)) {
            spokenIdsRef.current.add(signal.id);
            if (shouldStronglyAlert(signal.severity, signal.hazardCategory)) {
              setAlertedSignalId(signal.id);
              playAlertChime();
              // Only worth a real OS popup when the driver isn't already
              // looking at this tab -- otherwise the fresh list entry and
              // the speech about to play are already enough.
              if (document.hidden) {
                // The notification picture: the route driven since Start,
                // where the driver is and which way they're heading, and the
                // hazard (see public/alert-sketch.js). The path stays in this
                // browser -- it's passed to this device's own service
                // worker, never sent to the server.
                showAlertNotification(`${SEVERITY_LABELS[signal.severity]} road alert`, signal.speech.brief, {
                  trail: drivenPathRef.current,
                  position: { latitude, longitude },
                  headingDeg: heading,
                  hazard: { latitude: signal.latitude, longitude: signal.longitude },
                });
              }
            }
            speakSignal(signal);
          }
        }
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 401)) {
          clearStoredAccount();
          handleStop();
          setAccount(null);
          setRegistrationReason("We couldn't verify your Road Alerts account -- please register again below.");
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not check for road alerts.');
      }
    },
    [speakSignal, handleStop]
  );

  const onPosition = useCallback(
    (pos: GeolocationPosition) => {
      const { latitude, longitude, heading, speed } = pos.coords;
      const current = { latitude, longitude, timestampMs: pos.timestamp };
      const previous = lastFixRef.current;
      lastFixRef.current = current;

      // A derived speed/heading between two fixes is only trustworthy
      // once they're far enough apart that ordinary GPS jitter (a few
      // meters, even with enableHighAccuracy) is small relative to the
      // real movement being measured -- a short enough interval can
      // otherwise make jitter alone look like highway speed, and a
      // near-zero displacement gives a meaningless, noise-dominated
      // bearing rather than an accurate one.
      const displacementMeters = previous ? haversineDistanceMeters(previous, current) : null;
      const reliable = displacementMeters !== null && displacementMeters >= MIN_RELIABLE_DISPLACEMENT_METERS;

      // Prefers the device's own reported speed/heading -- reliable
      // regardless of fix spacing -- and only falls back to a fix-pair
      // estimate when the device doesn't report one at all. Heading in
      // particular is null on virtually every desktop browser and many
      // mobile ones too; without this fallback, isAhead's own "can't
      // tell, assume ahead" default would forward every hazard in range
      // regardless of actual direction, which is far less accurate than
      // a real bearing derived from where the driver just came from.
      const estimatedSpeedMps =
        typeof speed === 'number' && !Number.isNaN(speed)
          ? speed
          : reliable
            ? estimateSpeedMetersPerSecond(previous!, current)
            : null;
      const estimatedHeadingDeg =
        typeof heading === 'number' && heading >= 0 ? heading : reliable ? bearingDegrees(previous!, current) : null;

      setPosition({ latitude, longitude, heading: estimatedHeadingDeg });
      positionRef.current = { latitude, longitude };

      const lastDriven = drivenPathRef.current[drivenPathRef.current.length - 1];
      if (!lastDriven || haversineDistanceMeters(lastDriven, { latitude, longitude }) >= DRIVEN_PATH_STEP_METERS) {
        let path = [...drivenPathRef.current, { latitude, longitude }];
        if (path.length > DRIVEN_PATH_MAX_POINTS) path = path.filter((_, i) => i % 2 === 0 || i === path.length - 1);
        drivenPathRef.current = path;
        setDrivenPath(path);
      }

      if (
        !hasDetectedMovementRef.current &&
        estimatedSpeedMps !== null &&
        estimatedSpeedMps >= MOVING_SPEED_THRESHOLD_MPS
      ) {
        hasDetectedMovementRef.current = true;
        setHasDetectedMovement(true);
      }

      const now = Date.now();
      if (hasDetectedMovementRef.current && now - lastFetchAtRef.current >= POLL_MIN_INTERVAL_MS) {
        lastFetchAtRef.current = now;
        trailRef.current = [...trailRef.current, current].slice(-TRAIL_MAX_SAMPLES);
        fetchSignals(latitude, longitude, estimatedHeadingDeg);

        // Only from real GPS-driven polling (never handleManualCheck's direct
        // fetchSignals call), and only once a push subscription has actually
        // been confirmed by the server -- see pushSubscribedRef's comment.
        if (pushSubscribedRef.current) {
          const subscribedAccount = accountRef.current;
          if (subscribedAccount) {
            postRoadAlertsLivePosition({
              email: subscribedAccount.email,
              serviceKey: subscribedAccount.serviceKey,
              latitude,
              longitude,
              heading: estimatedHeadingDeg,
            }).catch(() => {
              // Best-effort -- a failed position update shouldn't block hazard display.
            });
          }
        }
      }

      // A simulated drive never feeds the real routine-route model -- see
      // simulatingRef's own comment.
      if (simulatingRef.current) return;

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

  // Feeds onPosition fake fixes along `drive`'s route instead of real GPS
  // -- everything downstream (movement detection, polling, matching,
  // chime, speech) is the real code path, unchanged. Fixes carry their own
  // heading/speed, the same way a phone that reports
  // GeolocationCoordinates.heading/speed does. Called again with a new
  // plan when the driver picks a detour mid-drive (handleDriveRerouteOption).
  const runSimulatedDrive = useCallback(
    (drive: { plan: DrivePlan; speedMps: number; label: string }) => {
      simulatedDriveRef.current = drive;
      const { plan, speedMps, label } = drive;
      const startedAtMs = Date.now();
      if (simulationTimerRef.current !== null) clearInterval(simulationTimerRef.current);
      simulatingRef.current = true;
      setSimulationProgress({ label, distanceMeters: 0, totalMeters: plan.totalMeters, done: false });
      setSimulatedRoute(plan.points.map((point) => [point.longitude, point.latitude]));
      const emitFix = () => {
        const nowMs = Date.now();
        const fix = positionAlongRoute(plan, ((nowMs - startedAtMs) / 1000) * speedMps);
        onPosition({
          coords: {
            latitude: fix.latitude,
            longitude: fix.longitude,
            heading: fix.headingDeg,
            speed: fix.done ? 0 : speedMps,
            accuracy: 5,
            altitude: null,
            altitudeAccuracy: null,
          },
          timestamp: nowMs,
        } as unknown as GeolocationPosition);
        setSimulationProgress({ label, distanceMeters: fix.distanceMeters, totalMeters: plan.totalMeters, done: fix.done });
        if (fix.done) handleStop();
      };
      simulationTimerRef.current = setInterval(emitFix, SIMULATED_FIX_INTERVAL_MS);
      emitFix();
      setWatching(true);
    },
    [onPosition, handleStop]
  );

  const handleStart = useCallback(() => {
    setError(null);
    if (!('geolocation' in navigator)) {
      setError('This browser does not support geolocation.');
      return;
    }
    // Ask once, here, rather than lazily the first time an alert would
    // want to show one -- prompting mid-alert would be a jarring first
    // ask. A no-op if already granted/denied, or if watching restarts
    // later in the same page session.
    requestNotificationPermission();

    // Best-effort, fire-and-forget -- a driver on a browser tab (not an
    // installed PWA) simply never gets a subscription, and keeps exactly
    // today's chime/in-tab-notification behavior. See
    // docs/superpowers/specs/2026-09-17-road-alerts-background-push-design.md.
    pushSubscribedRef.current = false;
    if (isPushCapable()) {
      const current = accountRef.current;
      if (current) {
        getRoadAlertsPushPublicKey()
          .then(({ publicKey }) => subscribeToPush(publicKey))
          .then((subscription) => {
            if (subscription) {
              return subscribeRoadAlertsPush({ email: current.email, serviceKey: current.serviceKey, subscription }).then(
                () => {
                  pushSubscribedRef.current = true;
                }
              );
            }
          })
          .catch(() => {
            // Best-effort -- push-public-key 404s (unconfigured server) land here too.
          });
      }
    }

    isFirstPositionOfSessionRef.current = true;
    hasDetectedMovementRef.current = false;
    setHasDetectedMovement(false);
    lastFixRef.current = null;
    trailRef.current = [];
    drivenPathRef.current = [];
    setDrivenPath([]);
    setOnRouteIds(new Set());
    setAlertedSignalId(null);

    // Simulated drive (from the sandbox): feed onPosition fake fixes along
    // the route instead of real GPS -- see runSimulatedDrive.
    const simulatedDrive = simulatedDriveRef.current;
    if (simulatedDrive) {
      runSimulatedDrive(simulatedDrive);
      return;
    }

    const id = navigator.geolocation.watchPosition(
      onPosition,
      (err) => setError(err.message || 'Could not start watching your location.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
    watchIdRef.current = id;
    setWatching(true);
  }, [onPosition, handleStop, runSimulatedDrive]);

  // Starts watching as soon as an account is ready, rather than waiting on
  // a press -- opening this page should surface alerts on its own. Depends
  // only on `account` (not `watching`) so this fires once per sign-in
  // rather than re-firing every time Stop (in Settings) flips `watching`
  // back to false.
  useEffect(() => {
    if (account) {
      handleStart();
    }
  }, [account, handleStart]);

  // Shared by the typed-coordinates form below and the Raising Alarm tab's
  // auto-triggered check (see the effect below it) -- same real
  // fetch/match/chime path either way, just a different source for the
  // coordinates.
  const runManualCheck = useCallback(
    async (latitude: number, longitude: number, heading: number | null) => {
      setError(null);
      setPosition({ latitude, longitude, heading });
      // Re-announces every match on each run, unlike the GPS-driven path
      // above -- repeatedly checking the same coordinates should keep
      // speaking/chiming, not go silent the second time.
      spokenIdsRef.current.clear();
      setManualChecking(true);
      try {
        await fetchSignals(latitude, longitude, heading);
      } finally {
        setManualChecking(false);
      }
    },
    [fetchSignals]
  );

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

    await runManualCheck(latitude, longitude, heading);
  }, [manualLatitude, manualLongitude, manualHeading, runManualCheck]);

  // Raising Alarm tab handoff: once an account is loaded, run the real
  // check immediately against the coords it captured, and pre-fill the
  // manual-check fields so the settings panel shows what triggered it.
  // Guarded by alarmTestRanRef so this only ever fires once per visit --
  // pendingAlarmTest itself never changes after mount (see above).
  useEffect(() => {
    if (!pendingAlarmTest || !account || alarmTestRanRef.current) return;
    alarmTestRanRef.current = true;
    const { latitude, longitude, heading } = pendingAlarmTest;
    setManualLatitude(String(latitude));
    setManualLongitude(String(longitude));
    setManualHeading(heading != null ? String(heading) : '');
    setSettingsOpen(true);
    runManualCheck(latitude, longitude, heading);

    // Also post this as a one-time live position, unlike handleManualCheck
    // above (and unlike onPosition's own GPS-driven polling, which only
    // posts once pushSubscribedRef confirms a real subscription -- see its
    // own comment). Raising Alarm is specifically a test of the background
    // push path end to end: without this, the push worker (which only ever
    // looks at road_alerts_live_positions) would have nothing to evaluate
    // for up to 10 minutes, until a real drive happened to report a fix.
    // Best-effort, same as every other position/ping call in this file --
    // a failure here shouldn't block the in-tab chime/list check above.
    postRoadAlertsLivePosition({ email: account.email, serviceKey: account.serviceKey, latitude, longitude, heading }).catch(
      () => {}
    );
  }, [pendingAlarmTest, account, runManualCheck]);

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

  const handleUseDifferentEmail = useCallback(() => {
    handleStop();
    clearStoredAccount();
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
      // Leave the toggle at its last-known-good value on failure.
    } finally {
      setDigestOptInSaving(false);
    }
  }, [digestOptIn, digestOptInSaving]);

  const handleChangeRoutineDensity = useCallback(
    async (next: RoadAlertsRoutineDensity) => {
      const current = accountRef.current;
      if (!current || routineDensitySaving || next === routineDensity) return;
      setRoutineDensitySaving(true);
      try {
        const response = await updateRoadAlertsPreferences({
          email: current.email,
          serviceKey: current.serviceKey,
          routineDensity: next,
        });
        setRoutineDensity(response.routineDensity);
      } catch {
        // Leave the setting at its last-known-good value on failure.
      } finally {
        setRoutineDensitySaving(false);
      }
    },
    [routineDensity, routineDensitySaving]
  );

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
      // Leave the draft in place on failure so the input isn't lost.
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
        // Leave the draft in place on failure.
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
        // Leave the draft in place on failure.
      } finally {
        setPostingSignalId(null);
      }
    },
    [draftReplyText, postingSignalId]
  );

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

  // Auto-fetch the cheap cross-street hint for any signal that's ahead,
  // once a position exists -- best-effort (a 404/422 just means nothing
  // qualified) and fetched at most once per signal id via the ref, not
  // re-triggered by crossStreetBySignalId's own updates.
  useEffect(() => {
    const current = accountRef.current;
    if (!current || !position) return;
    for (const signal of signals) {
      if (typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') continue;
      if (crossStreetFetchedRef.current.has(signal.id)) continue;
      const bearing = bearingDegrees(
        { latitude: position.latitude, longitude: position.longitude },
        { latitude: signal.latitude, longitude: signal.longitude }
      );
      if (!isAhead(position.heading, bearing)) continue;

      crossStreetFetchedRef.current.add(signal.id);
      setCrossStreetBySignalId((prev) => ({ ...prev, [signal.id]: 'loading' }));
      getRoadAlertsCrossStreet({
        driverLatitude: position.latitude,
        driverLongitude: position.longitude,
        hazardLatitude: signal.latitude,
        hazardLongitude: signal.longitude,
        hazardRoadway: signal.roadway ?? undefined,
        email: current.email,
        serviceKey: current.serviceKey,
      })
        .then((result) => setCrossStreetBySignalId((prev) => ({ ...prev, [signal.id]: result })))
        .catch(() => setCrossStreetBySignalId((prev) => ({ ...prev, [signal.id]: 'none' })));
    }
  }, [signals, position]);

  // The running simulated drive's target (its route's last point), or
  // undefined when not simulating.
  const simulationDestination = () => {
    const points = simulatedDriveRef.current?.plan.points;
    const last = points?.[points.length - 1];
    return last ? { latitude: last.latitude, longitude: last.longitude } : undefined;
  };

  // "Drive this route" on a detour, mid simulated drive: the route is
  // recalculated from where the car is NOW to the drive's target (see
  // simulationDestination), then driven. The detour was computed a little
  // while ago from where the car used to be, so driving it from its own
  // first point sent the car back there and into a U-turn. If the car is
  // still on the chosen route, only the part ahead of it is driven;
  // otherwise (it has passed where the detour turns off) fresh detours are
  // fetched from here and the one closest to the chosen route is driven.
  // The trail so far and alerts already raised are kept; detours computed
  // for the old route are dropped.
  const [switchingRoute, setSwitchingRoute] = useState(false);
  const handleDriveRerouteOption = useCallback(
    async (signal: RoadSignal, option: RerouteOption, index: number) => {
      const drive = simulatedDriveRef.current;
      const current = accountRef.current;
      if (!drive || !simulatingRef.current || !current) return;
      const carNow = () => lastFixRef.current ?? positionRef.current;
      const here = carNow();
      if (!here) return;

      let route = routeAheadOf(here, option.geometry.coordinates);
      if (!route && typeof signal.latitude === 'number' && typeof signal.longitude === 'number') {
        setSwitchingRoute(true);
        try {
          const fresh = await getRoadReroute({
            driverLatitude: here.latitude,
            driverLongitude: here.longitude,
            driverHeading: position?.heading ?? undefined,
            hazardLatitude: signal.latitude,
            hazardLongitude: signal.longitude,
            destination: simulationDestination(),
            email: current.email,
            serviceKey: current.serviceKey,
          });
          const closest = [...fresh.options].sort(
            (a, b) =>
              routeOverlap(b.geometry.coordinates, option.geometry.coordinates) -
              routeOverlap(a.geometry.coordinates, option.geometry.coordinates)
          )[0];
          // The car kept moving while that was fetched.
          const latest = carNow() ?? here;
          if (closest) {
            route =
              routeAheadOf(latest, closest.geometry.coordinates) ?? [
                [latest.longitude, latest.latitude],
                ...closest.geometry.coordinates,
              ];
          }
        } catch {
          // Keep driving the current route -- nothing better to switch to.
        } finally {
          setSwitchingRoute(false);
        }
      }
      if (!route || !simulatingRef.current) return;
      let plan: DrivePlan;
      try {
        plan = buildDrivePlan(route);
      } catch {
        return;
      }
      const baseLabel = drive.label.replace(/ \(detour option \d+\)$/, '');
      runSimulatedDrive({ plan, speedMps: drive.speedMps, label: `${baseLabel} (detour option ${index + 1})` });
      setRerouteBySignalId({});
      setExpandedRerouteSignalId(null);
      setHoveredRouteIndex(null);
    },
    [runSimulatedDrive, position]
  );

  const handleToggleReroute = useCallback(
    async (signal: RoadSignal) => {
      setHoveredRouteIndex(null);
      if (expandedRerouteSignalId === signal.id) {
        setExpandedRerouteSignalId(null);
        return;
      }
      setExpandedRerouteSignalId(signal.id);
      // A successful result is kept for the session; a failed one is retried
      // on the next click -- e.g. a hazard that was too far away a minute
      // ago may be within range now.
      const previous = rerouteBySignalId[signal.id];
      if (previous && (previous === 'loading' || !('error' in previous))) return;

      const current = accountRef.current;
      if (!current || !position || typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') {
        return;
      }

      setRerouteBySignalId((prev) => ({ ...prev, [signal.id]: 'loading' }));
      try {
        const response = await getRoadReroute({
          driverLatitude: position.latitude,
          driverLongitude: position.longitude,
          driverHeading: position.heading ?? undefined,
          hazardLatitude: signal.latitude,
          hazardLongitude: signal.longitude,
          hazardRoadway: signal.roadway ?? undefined,
          // A simulated drive knows where it's going: route there, not to
          // an estimated point past the hazard.
          destination: simulatingRef.current ? simulationDestination() : undefined,
          email: current.email,
          serviceKey: current.serviceKey,
        });
        setRerouteBySignalId((prev) => ({ ...prev, [signal.id]: response }));
      } catch (err) {
        const hazardDistanceMeters = haversineDistanceMeters(
          { latitude: position.latitude, longitude: position.longitude },
          { latitude: signal.latitude, longitude: signal.longitude }
        );
        setRerouteBySignalId((prev) => ({
          ...prev,
          [signal.id]: { error: rerouteErrorMessage(err, hazardDistanceMeters) },
        }));
      }
    },
    [expandedRerouteSignalId, rerouteBySignalId, position]
  );

  // Alerting only runs while this page is mounted -- navigating away
  // without pressing Stop would otherwise leak a location watch.
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      if (simulationTimerRef.current !== null) clearInterval(simulationTimerRef.current);
      window.speechSynthesis?.cancel();
    };
  }, []);

  // The driven path as map coordinates (see drivenPath).
  const drivenLine = useMemo<[number, number][]>(
    () => drivenPath.map(({ latitude, longitude }) => [longitude, latitude]),
    [drivenPath]
  );

  const mapPoints = useMemo<SandboxPoint[]>(
    () =>
      signals
        .filter((s): s is RoadSignal & { latitude: number; longitude: number } =>
          typeof s.latitude === 'number' && typeof s.longitude === 'number'
        )
        .map((s) => ({
          id: s.id,
          latitude: s.latitude,
          longitude: s.longitude,
          color: '#a4402a',
          label: `${SEVERITY_LABELS[s.severity]} -- ${s.roadway ?? 'Unknown road'}`,
        })),
    [signals]
  );

  const selectedSignal = signals.find((s) => s.id === selectedSignalId) ?? null;
  const focusPoint =
    selectedSignal && typeof selectedSignal.latitude === 'number' && typeof selectedSignal.longitude === 'number'
      ? { latitude: selectedSignal.latitude, longitude: selectedSignal.longitude }
      : null;

  const handleSelectSignal = (id: string) => {
    setSelectedSignalId(id);
    mapContainerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // The reverse direction: clicking a map marker selects it (same focus
  // behavior) and scrolls its card into view, mirroring
  // RoadAlertsHomeBoard.tsx's own handleMarkerClick exactly.
  const handleMarkerClick = (id: string) => {
    setSelectedSignalId(id);
    cardRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  if (account === null) {
    return (
      <div>
        <PageHeader icon="roadAlerts">Road Alerts</PageHeader>
        <RoadAlertsTabs />
        <p className="text-muted" style={{ marginBottom: 'var(--space-6)' }}>
          Live traffic hazards near you, spoken aloud as you approach them.
        </p>
        <RoadAlertsRegistration onRegistered={setAccount} reason={registrationReason} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <PageHeader icon="roadAlerts">Road Alerts</PageHeader>
      <RoadAlertsTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Live traffic hazards near you, spoken aloud as you approach them.
      </p>

      {simulationProgress && (
        <div className="card elev-sm" style={{ marginBottom: 'var(--space-3)', padding: 'var(--space-3)' }}>
          <div className="card-title" style={{ fontSize: 15, marginBottom: 'var(--space-1)' }}>
            {simulationProgress.done
              ? `Simulated drive finished: ${simulationProgress.label}`
              : `Simulated drive: ${simulationProgress.label}`}
          </div>
          <p className="card-body" style={{ margin: 0 }}>
            {(simulationProgress.distanceMeters / 1000).toFixed(2)} of {(simulationProgress.totalMeters / 1000).toFixed(2)}{' '}
            km ({Math.round((simulationProgress.distanceMeters / simulationProgress.totalMeters) * 100)}%). Fake GPS
            fixes from the Road Alerts sandbox -- never recorded as real weighted points.
            {!watching && ' Start watching (in Settings) to switch back to real GPS.'}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-2)', flexWrap: 'wrap' }}>
            {watching && (
              <button className="btn btn-secondary" onClick={handleStop}>
                Stop simulated drive
              </button>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={followCar} onChange={(e) => setFollowCar(e.target.checked)} />
              Follow car on the map
            </label>
          </div>
        </div>
      )}

      <button
        className="btn btn-ghost"
        style={{ marginBottom: 'var(--space-4)' }}
        onClick={() => setSettingsOpen((o) => !o)}
      >
        {settingsOpen ? 'Hide settings' : 'Settings'}
      </button>

      {settingsOpen && (
        <>
      <div className="card" style={{ background: 'var(--color-surface)', marginBottom: 'var(--space-4)' }}>
        <p className="card-body" style={{ margin: 0 }}>
          Traffic data from New England 511 (Maine, New Hampshire, and Vermont DOTs). Provided
          as-is, with no accuracy or uptime guarantee. Each hazard check sends your location for
          one live lookup, not stored. Separately, while watching is on, occasional pings (every
          few minutes, excluding trip start/end) help build a routine-route model for smarter
          future alerts -- never your destinations, only points visited often enough to qualify.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
          }}
        >
          <p className="card-body" style={{ margin: 0 }}>
            Registered as <strong>{account.email}</strong>. Free while we're testing this -- no
            payment required.
          </p>
          <button className="btn btn-ghost" onClick={handleUseDifferentEmail}>
            Not you? Use a different email
          </button>
        </div>
        <div className="hr" />
        <p className="card-body" style={{ margin: '0 0 var(--space-2)' }}>
          Daily email digest: recaps alerts you explicitly save while driving (the "save"/"keep"/
          "email" voice command) -- not everything spoken aloud along the way.
        </p>
        <button
          className={`btn ${digestOptIn ? 'btn-primary' : 'btn-secondary'}`}
          onClick={handleToggleDigest}
          disabled={digestOptInSaving}
        >
          {digestOptInSaving ? 'Saving…' : digestOptIn ? 'Daily email digest: On' : 'Daily email digest: Off'}
        </button>

        <div className="hr" />
        <p className="card-body" style={{ margin: '0 0 var(--space-2)' }}>
          How much of your routine driving Road Alerts remembers, to catch relevant hazards on
          routes you actually drive.
        </p>
        <div className="seg" style={{ width: '100%', marginBottom: 'var(--space-2)' }}>
          {ROUTINE_DENSITY_OPTIONS.map((opt) => (
            <label key={opt.value} className="seg-opt" style={{ flex: 1, justifyContent: 'center' }}>
              <input
                type="radio"
                name="routineDensity"
                checked={routineDensity === opt.value}
                onChange={() => handleChangeRoutineDensity(opt.value)}
                disabled={routineDensitySaving}
              />
              {opt.label}
            </label>
          ))}
        </div>
        <p className="card-meta" style={{ margin: 0 }}>
          {routineDensitySaving
            ? 'Saving…'
            : ROUTINE_DENSITY_OPTIONS.find((opt) => opt.value === routineDensity)?.description}
        </p>

        {username ? (
          <p className="card-body" style={{ margin: 'var(--space-3) 0 0' }}>
            Posting as <strong>{username}</strong>.
          </p>
        ) : (
          username !== undefined && (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <p className="card-body" style={{ margin: '0 0 var(--space-2)' }}>
                Set a display name before posting a comment on a road alert -- shown instead of
                your email.
              </p>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <input
                  className="input"
                  placeholder="Display name"
                  value={usernameDraft}
                  onChange={(e) => setUsernameDraft(e.target.value)}
                  maxLength={40}
                />
                <button
                  className="btn btn-secondary"
                  onClick={handleSaveUsername}
                  disabled={usernameSaving || !usernameDraft.trim()}
                >
                  {usernameSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-4)',
          marginBottom: 'var(--space-2)',
          alignItems: 'end',
        }}
      >
        <div className="field">
          <label>Spoken detail level</label>
          <div className="seg" style={{ width: '100%' }}>
            {DETAIL_OPTIONS.map((opt) => (
              <label key={opt.value} className="seg-opt" style={{ flex: 1, justifyContent: 'center' }}>
                <input
                  type="radio"
                  name="detailLevel"
                  checked={detailLevel === opt.value}
                  onChange={() => setDetailLevel(opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setVoiceEnabled((v) => !v)}>
            {voiceEnabled ? 'Voice: On' : 'Voice: Muted'}
          </button>
          <button
            className={`btn ${watching ? 'btn-secondary' : 'btn-primary'}`}
            style={{ flex: 1 }}
            onClick={watching ? handleStop : handleStart}
          >
            {watching ? 'Stop' : 'Start watching'}
          </button>
        </div>
      </div>

      <p className="card-meta" style={{ marginBottom: 'var(--space-4)' }}>
        {position
          ? `Watching near ${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}`
          : watching
            ? 'Waiting for a GPS fix…'
            : 'Not watching your location yet.'}
      </p>

      <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="card-title" style={{ fontSize: 15 }}>
          Test a location manually
        </div>
        <p className="card-body" style={{ margin: '0 0 var(--space-2)' }}>
          Type coordinates instead of using GPS -- useful on a desktop, where there's no real
          location to drive around.
        </p>
        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' }}
        >
          <input
            className="input"
            placeholder="Latitude"
            value={manualLatitude}
            onChange={(e) => setManualLatitude(e.target.value)}
          />
          <input
            className="input"
            placeholder="Longitude"
            value={manualLongitude}
            onChange={(e) => setManualLongitude(e.target.value)}
          />
        </div>
        <input
          className="input"
          placeholder="Heading in degrees, optional -- blank means 'assume ahead'"
          value={manualHeading}
          onChange={(e) => setManualHeading(e.target.value)}
          style={{ marginBottom: 'var(--space-2)' }}
        />
        <button className="btn btn-primary" onClick={handleManualCheck} disabled={manualChecking}>
          {manualChecking ? 'Checking…' : 'Check this location'}
        </button>
      </div>
        </>
      )}

      {error && (
        <p className="card-body" style={{ color: '#a4402a', marginBottom: 'var(--space-4)' }}>
          {error}
        </p>
      )}
      {!error && partial && (
        <p className="card-meta" style={{ marginBottom: 'var(--space-4)' }}>
          One or more 511 networks are temporarily unavailable -- showing partial results.
        </p>
      )}

      {watching && !hasDetectedMovement && signals.length === 0 ? (
        <p className="text-muted">
          Waiting to confirm you're actually driving before checking for hazards -- start moving, or use
          "Test a location manually" in Settings to check a spot right away.
        </p>
      ) : (
        <>
          <h5 className="text-muted" style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {signals.length} alert{signals.length === 1 ? '' : 's'} within {metersLabel(RADIUS_METERS)}
          </h5>

          {/* Always shown during a simulated drive, hazards nearby or not --
              watching the car move along its route is the point of it. */}
          {(mapPoints.length > 0 || simulatedRoute) && (
            <div ref={mapContainerRef} style={{ marginBottom: 'var(--space-4)' }}>
              <RoadAlertsSandboxMap
                points={mapPoints}
                driverPosition={position}
                driverLabel={simulatedRoute ? 'Simulated car' : 'Your current position'}
                focusPoint={focusPoint}
                onPointClick={handleMarkerClick}
                routeLine={simulatedRoute}
                drivenLine={drivenLine}
                followDriver={simulatedRoute !== null && followCar}
              />
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {signals.map((signal, index) => {
          const onRoute = onRouteIds.has(signal.id);
          const ahead =
            onRoute ||
            (position && typeof signal.latitude === 'number' && typeof signal.longitude === 'number'
              ? isAhead(
                  position.heading,
                  bearingDegrees(
                    { latitude: position.latitude, longitude: position.longitude },
                    { latitude: signal.latitude, longitude: signal.longitude }
                  )
                )
              : true);
          const distance =
            position && typeof signal.latitude === 'number' && typeof signal.longitude === 'number'
              ? haversineDistanceMeters(
                  { latitude: position.latitude, longitude: position.longitude },
                  { latitude: signal.latitude, longitude: signal.longitude }
                )
              : null;
          const topicState = topicBySignalId[signal.id];

          const justAlerted = signal.id === alertedSignalId;
          const selected = signal.id === selectedSignalId;
          const hasCoordinates = typeof signal.latitude === 'number' && typeof signal.longitude === 'number';

          return (
            <div
              key={signal.id}
              ref={(el) => {
                cardRefs.current[signal.id] = el;
              }}
              className="card elev-sm"
              onClick={hasCoordinates ? () => handleSelectSignal(signal.id) : undefined}
              style={{
                cursor: hasCoordinates ? 'pointer' : undefined,
                ...(index === 0 ? { background: 'var(--color-accent-100)' } : undefined),
                ...(justAlerted ? { border: '2px solid var(--color-accent-600)' } : undefined),
                ...(selected ? { outline: '2px solid var(--color-accent-500)' } : undefined),
              }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}
              >
                <span className="card-kicker">
                  {distance !== null ? `${metersLabel(distance)} away` : 'distance unknown'}
                  {onRoute ? ' · on your route' : !ahead ? ' · behind you' : ''}
                  {justAlerted ? ' · 🔔 just alerted' : ''}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                  <span className={`tag ${SEVERITY_TAG_CLASS[signal.severity]}`}>
                    {SEVERITY_LABELS[signal.severity]}
                  </span>
                  <span className="card-kicker">{freshnessLabel(signal)}</span>
                </span>
              </div>
              <div className="card-title" style={{ fontSize: 17 }}>
                <span
                  role="img"
                  aria-label={HAZARD_CATEGORY_LABELS[signal.hazardCategory]}
                  title={HAZARD_CATEGORY_LABELS[signal.hazardCategory]}
                  style={{ marginRight: 6 }}
                >
                  {HAZARD_CATEGORY_ICONS[signal.hazardCategory]}
                </span>
                {signal.roadway ?? 'Unknown road'}
                {signal.direction ? ` (${signal.direction})` : ''}
              </div>
              <p className="card-body">{signal.speech[detailLevel]}</p>
              {position && typeof signal.latitude === 'number' && typeof signal.longitude === 'number' && (
                <AlertSketch
                  input={{
                    trail: drivenPath,
                    position: { latitude: position.latitude, longitude: position.longitude },
                    headingDeg: position.heading,
                    hazard: { latitude: signal.latitude, longitude: signal.longitude },
                  }}
                />
              )}
              {(() => {
                const crossStreet = crossStreetBySignalId[signal.id];
                if (!crossStreet || crossStreet === 'loading' || crossStreet === 'none') return null;
                return (
                  <p className="card-meta" style={{ margin: '0 0 var(--space-2)' }}>
                    Nearest turn-off: <strong>{crossStreet.fullname}</strong>,{' '}
                    {metersLabel(crossStreet.distanceFromDriverMeters)} ahead
                  </p>
                );
              })()}
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: 'var(--space-2)' }}>
                <button className="btn btn-ghost" onClick={() => speakSignal(signal)}>
                  Speak
                </button>
                {speechRecognitionAvailable && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleListenForSaveCommand(signal)}
                    disabled={Boolean(voiceListeningSignalId)}
                  >
                    {voiceListeningSignalId === signal.id ? 'Listening…' : 'Use voice: "save this"'}
                  </button>
                )}
                <button className="btn btn-ghost" onClick={() => handleToggleComments(signal)}>
                  {expandedSignalId === signal.id ? 'Hide comments' : 'Comments'}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => handleToggleReroute(signal)}
                  disabled={!position}
                  title={position ? undefined : 'Start watching or check a location first'}
                >
                  {expandedRerouteSignalId === signal.id ? 'Hide route options' : 'Show a way around this'}
                </button>
              </div>
              {voiceStatusBySignalId[signal.id] && (
                <p className="card-meta" style={{ marginTop: 'var(--space-1)' }}>
                  {voiceStatusBySignalId[signal.id]}
                </p>
              )}

              {expandedRerouteSignalId === signal.id &&
                (() => {
                  const rerouteState = rerouteBySignalId[signal.id];
                  return (
                    <div
                      style={{
                        marginTop: 'var(--space-3)',
                        paddingTop: 'var(--space-3)',
                        borderTop: '1px solid var(--color-divider)',
                      }}
                    >
                      {rerouteState === 'loading' && <p className="card-meta">Finding a way around…</p>}
                      {rerouteState && rerouteState !== 'loading' && 'error' in rerouteState && (
                        <p className="card-meta">{rerouteState.error}</p>
                      )}
                      {rerouteState && rerouteState !== 'loading' && !('error' in rerouteState) && position && (
                        <>
                          {rerouteState.options.length === 0 ? (
                            <p className="card-meta">No alternate route found around this hazard.</p>
                          ) : (
                            <>
                              <RoadRerouteMap
                                driverPosition={{ latitude: position.latitude, longitude: position.longitude }}
                                hazardPosition={{
                                  latitude: signal.latitude as number,
                                  longitude: signal.longitude as number,
                                }}
                                rejoinPoint={rerouteState.rejoinPoint}
                                rejoinLabel={rerouteState.endsAtDestination ? 'Destination' : undefined}
                                options={rerouteState.options}
                                highlightedIndex={hoveredRouteIndex}
                              />
                              <div style={{ marginTop: 'var(--space-2)' }}>
                                {rerouteState.options.map((option, index) => (
                                  <div
                                    key={index}
                                    onMouseEnter={() => setHoveredRouteIndex(index)}
                                    onMouseLeave={() => setHoveredRouteIndex(null)}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'space-between',
                                      gap: 'var(--space-2)',
                                      margin: '2px 0',
                                      padding: '4px 6px',
                                      borderRadius: 'var(--radius-sm)',
                                      cursor: 'default',
                                      background:
                                        hoveredRouteIndex === index ? 'var(--color-surface)' : 'transparent',
                                    }}
                                  >
                                    <p className="card-meta" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                                      <span
                                        aria-hidden="true"
                                        style={{
                                          display: 'inline-block',
                                          width: 10,
                                          height: 10,
                                          borderRadius: '50%',
                                          background: ROUTE_COLORS[index % ROUTE_COLORS.length],
                                          flexShrink: 0,
                                        }}
                                      />
                                      Option {index + 1}:{' '}
                                      {option.distanceMeters !== null ? metersLabel(option.distanceMeters) : '?'}
                                      {option.durationSeconds !== null
                                        ? `, ~${Math.round(option.durationSeconds / 60)} min`
                                        : ''}
                                      {option.usesWeightedPoints && (
                                        <span className="tag tag-accent" style={{ marginLeft: 6 }}>
                                          ★ uses your usual roads
                                        </span>
                                      )}
                                    </p>
                                    <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
                                    {simulationProgress && !simulationProgress.done && rerouteState.endsAtDestination && (
                                      <button
                                        type="button"
                                        className="btn btn-primary"
                                        style={{ padding: '2px 10px', fontSize: 13 }}
                                        onClick={() => handleDriveRerouteOption(signal, option, index)}
                                        disabled={switchingRoute}
                                      >
                                        {switchingRoute ? 'Recalculating…' : 'Drive this route'}
                                      </button>
                                    )}
                                    {position && (
                                      <a
                                        className="btn btn-ghost"
                                        style={{ padding: '2px 10px', fontSize: 13 }}
                                        href={buildGoogleMapsDirectionsUrl(
                                          { latitude: position.latitude, longitude: position.longitude },
                                          rerouteState.rejoinPoint,
                                          option
                                        )}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        Navigate with Google Maps
                                      </a>
                                    )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                              <p className="card-meta" style={{ marginTop: 'var(--space-2)' }}>
                                {rerouteState.endsAtDestination
                                  ? "Routes go to your simulated drive's target."
                                  : "Rejoin point is estimated ~1 mi past the hazard, not exact -- 511 data doesn't give the hazard's full extent."} Routes are based on street connectivity only -- they
                                don't account for one-way streets.
                              </p>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  );
                })()}

              {expandedSignalId === signal.id && (
                <div
                  style={{
                    marginTop: 'var(--space-3)',
                    paddingTop: 'var(--space-3)',
                    borderTop: '1px solid var(--color-divider)',
                  }}
                >
                  {topicState === 'loading' && <p className="card-meta">Loading comments…</p>}
                  {topicState === 'error' && <p className="card-meta">Could not load comments.</p>}
                  {topicState && topicState !== 'loading' && topicState !== 'error' && (
                    <>
                      {topicState.statements.length === 0 && (
                        <p className="card-meta" style={{ marginBottom: 'var(--space-2)' }}>
                          No comments here yet.
                        </p>
                      )}
                      {topicState.statements.map((statement) => (
                        <div key={statement.id} style={{ marginBottom: 'var(--space-3)' }}>
                          <p className="card-meta" style={{ margin: 0 }}>
                            {statement.username} · {new Date(statement.createdAt).toLocaleString()}
                          </p>
                          <p className="card-body" style={{ margin: '2px 0' }}>
                            {statement.body}
                          </p>
                          {statement.replies.map((reply) => (
                            <div key={reply.id} style={{ marginLeft: 'var(--space-4)', marginTop: 'var(--space-1)' }}>
                              <p className="card-meta" style={{ margin: 0 }}>
                                {reply.username} · {new Date(reply.createdAt).toLocaleString()}
                              </p>
                              <p className="card-body" style={{ margin: '2px 0' }}>
                                {reply.body}
                              </p>
                            </div>
                          ))}
                          {username &&
                            (replyingToStatementId === statement.id ? (
                              <div style={{ marginTop: 'var(--space-1)', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                                  <input
                                    className="input"
                                    placeholder="Reply"
                                    value={draftReplyText}
                                    onChange={(e) => setDraftReplyText(e.target.value)}
                                  />
                                  {speechRecognitionAvailable && (
                                    <button
                                      className="btn btn-ghost"
                                      onClick={() => handleListenForComment(signal, setDraftReplyText)}
                                      disabled={Boolean(voiceListeningStatementSignalId)}
                                    >
                                      {voiceListeningStatementSignalId === signal.id ? 'Listening…' : 'Use voice'}
                                    </button>
                                  )}
                                </div>
                                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                                  <button
                                    className="btn btn-primary"
                                    onClick={() => handlePostReply(signal, statement.id)}
                                    disabled={postingSignalId === signal.id || !draftReplyText.trim()}
                                  >
                                    {postingSignalId === signal.id ? 'Posting…' : 'Post reply'}
                                  </button>
                                  <button className="btn btn-ghost" onClick={() => setReplyingToStatementId(null)}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button
                                className="btn btn-ghost"
                                onClick={() => setReplyingToStatementId(statement.id)}
                              >
                                Reply
                              </button>
                            ))}
                        </div>
                      ))}
                      {username ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                            <input
                              className="input"
                              placeholder="Add a comment"
                              value={draftStatementBySignalId[signal.id] ?? ''}
                              onChange={(e) =>
                                setDraftStatementBySignalId((prev) => ({ ...prev, [signal.id]: e.target.value }))
                              }
                            />
                            {speechRecognitionAvailable && (
                              <button
                                className="btn btn-ghost"
                                onClick={() =>
                                  handleListenForComment(signal, (transcript) =>
                                    setDraftStatementBySignalId((prev) => ({ ...prev, [signal.id]: transcript }))
                                  )
                                }
                                disabled={Boolean(voiceListeningStatementSignalId)}
                              >
                                {voiceListeningStatementSignalId === signal.id ? 'Listening…' : 'Use voice'}
                              </button>
                            )}
                          </div>
                          <button
                            className="btn btn-primary"
                            onClick={() => handlePostStatement(signal)}
                            disabled={postingSignalId === signal.id || !(draftStatementBySignalId[signal.id] ?? '').trim()}
                          >
                            {postingSignalId === signal.id ? 'Posting…' : 'Post'}
                          </button>
                          {voiceStatementStatusBySignalId[signal.id] && (
                            <p className="card-meta" style={{ margin: 0 }}>
                              {voiceStatementStatusBySignalId[signal.id]}
                            </p>
                          )}
                        </div>
                      ) : (
                        <p className="card-meta">Set a display name above to post a comment.</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
          </div>
        </>
      )}
    </div>
  );
}
