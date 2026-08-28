import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError,
  emailRoadAlert,
  getRoadAlertsCrossStreet,
  getRoadAlertsPreferences,
  getRoadAlertsTopic,
  getRoadAlertsUsername,
  getRoadReroute,
  getRoadSignals,
  markRoadAlertsNotificationsViewed,
  postRoadAlertsStatement,
  updateRoadAlertsPreferences,
  updateRoadAlertsUsername,
} from '../../../shared/api/client';
import type {
  CrossStreetResponse,
  RoadAlertsTopicResponse,
  RoadRerouteResponse,
  RoadSignal,
  RoadSignalSeverity,
} from '../../../shared/api/types';
import { bearingDegrees, haversineDistanceMeters, isAhead } from '../../../shared/geo';
import { buildGoogleMapsDirectionsUrl } from '../../../shared/googleMapsDirections';
import { HAZARD_CATEGORY_ICONS, HAZARD_CATEGORY_LABELS } from '../../../shared/hazardCategories';
import PageHeader from '../components/PageHeader';
import RoadAlertsRegistration from '../components/RoadAlertsRegistration';
import RoadRerouteMap, { ROUTE_COLORS } from '../components/RoadRerouteMap';
import { clearStoredAccount, getStoredAccount, type StoredRoadAlertsAccount } from '../roadAlertsStorage';
import { isSpeechRecognitionAvailable, listenOnce, matchesSaveCommand } from '../webSpeechRecognition';

type DetailLevel = 'brief' | 'average' | 'deep';

const DETAIL_OPTIONS: { label: string; value: DetailLevel }[] = [
  { label: 'Brief', value: 'brief' },
  { label: 'Average', value: 'average' },
  { label: 'Deep', value: 'deep' },
];

const RADIUS_METERS = 10000;
// Ties polling to real movement (the watch callback firing again) rather
// than a separate timer, but still caps how often the free public 511
// API gets hit if the browser reports position rapidly.
const POLL_MIN_INTERVAL_MS = 15000;

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

export default function RoadAlerts() {
  const [account, setAccount] = useState<StoredRoadAlertsAccount | null>(() => getStoredAccount());
  const [registrationReason, setRegistrationReason] = useState<string | null>(null);

  const [watching, setWatching] = useState(false);
  const [position, setPosition] = useState<{ latitude: number; longitude: number; heading: number | null } | null>(
    null
  );
  const [signals, setSignals] = useState<RoadSignal[]>([]);
  // Spoken alerts default to the shortest form -- something you hear
  // while approaching a hazard should be as small as possible.
  const [detailLevel, setDetailLevel] = useState<DetailLevel>('brief');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [digestOptIn, setDigestOptIn] = useState(false);
  const [digestOptInSaving, setDigestOptInSaving] = useState(false);
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
    Record<string, RoadRerouteResponse | 'loading' | 'error'>
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
  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);
  useEffect(() => {
    detailLevelRef.current = detailLevel;
  }, [detailLevel]);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  // Digest opt-in, username, and the notifications-viewed mark are all
  // best-effort, fetch-fresh-on-account-change: a failure just leaves a
  // default value rather than surfacing an error for something this
  // minor.
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
    window.speechSynthesis?.cancel();
    setWatching(false);
  }, []);

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

        for (const signal of response.signals) {
          if (spokenIdsRef.current.has(signal.id)) continue;
          if (typeof signal.latitude !== 'number' || typeof signal.longitude !== 'number') continue;
          const bearing = bearingDegrees(
            { latitude, longitude },
            { latitude: signal.latitude, longitude: signal.longitude }
          );
          const ahead = isAhead(heading, bearing);
          spokenIdsRef.current.add(signal.id);
          if (ahead && shouldAutoSpeak(signal.severity)) {
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
      const { latitude, longitude, heading } = pos.coords;
      setPosition({ latitude, longitude, heading });

      const now = Date.now();
      if (now - lastFetchAtRef.current < POLL_MIN_INTERVAL_MS) return;
      lastFetchAtRef.current = now;
      fetchSignals(latitude, longitude, heading);
    },
    [fetchSignals]
  );

  const handleStart = useCallback(() => {
    setError(null);
    if (!('geolocation' in navigator)) {
      setError('This browser does not support geolocation.');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      onPosition,
      (err) => setError(err.message || 'Could not start watching your location.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
    watchIdRef.current = id;
    setWatching(true);
  }, [onPosition]);

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
    // Re-announces every match on each press, unlike the GPS-driven path
    // above -- repeatedly checking the same typed coordinates should
    // keep speaking, not go silent the second time.
    spokenIdsRef.current.clear();
    setManualChecking(true);
    try {
      await fetchSignals(latitude, longitude, heading);
    } finally {
      setManualChecking(false);
    }
  }, [manualLatitude, manualLongitude, manualHeading, fetchSignals]);

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

  const handleToggleReroute = useCallback(
    async (signal: RoadSignal) => {
      setHoveredRouteIndex(null);
      if (expandedRerouteSignalId === signal.id) {
        setExpandedRerouteSignalId(null);
        return;
      }
      setExpandedRerouteSignalId(signal.id);
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
          driverHeading: position.heading ?? undefined,
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

  // Alerting only runs while this page is mounted -- navigating away
  // without pressing Stop would otherwise leak a location watch.
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
      window.speechSynthesis?.cancel();
    };
  }, []);

  if (account === null) {
    return (
      <div>
        <PageHeader icon="roadAlerts">Road Alerts</PageHeader>
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
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        Live traffic hazards near you, spoken aloud as you approach them.
      </p>

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
          as-is, with no accuracy or uptime guarantee. Your location is sent for one live check at
          a time and isn't stored.
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

      <h5 className="text-muted" style={{ letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {signals.length} alert{signals.length === 1 ? '' : 's'} within {metersLabel(RADIUS_METERS)}
      </h5>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        {signals.map((signal, index) => {
          const ahead =
            position && typeof signal.latitude === 'number' && typeof signal.longitude === 'number'
              ? isAhead(
                  position.heading,
                  bearingDegrees(
                    { latitude: position.latitude, longitude: position.longitude },
                    { latitude: signal.latitude, longitude: signal.longitude }
                  )
                )
              : true;
          const distance =
            position && typeof signal.latitude === 'number' && typeof signal.longitude === 'number'
              ? haversineDistanceMeters(
                  { latitude: position.latitude, longitude: position.longitude },
                  { latitude: signal.latitude, longitude: signal.longitude }
                )
              : null;
          const topicState = topicBySignalId[signal.id];

          return (
            <div
              key={signal.id}
              className="card elev-sm"
              style={index === 0 ? { background: 'var(--color-accent-100)' } : undefined}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}
              >
                <span className="card-kicker">
                  {distance !== null ? `${metersLabel(distance)} away` : 'distance unknown'}
                  {!ahead ? ' · behind you' : ''}
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
                      {rerouteState === 'error' && (
                        <p className="card-meta">Could not find a detour right now.</p>
                      )}
                      {rerouteState && rerouteState !== 'loading' && rerouteState !== 'error' && position && (
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
                                    </p>
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
                                ))}
                              </div>
                              <p className="card-meta" style={{ marginTop: 'var(--space-2)' }}>
                                Rejoin point is estimated ~1 mi past the hazard, not exact -- 511 data doesn't give
                                the hazard's full extent. Routes are based on street connectivity only -- they
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
    </div>
  );
}
