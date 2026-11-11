import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, getAddressInferenceReview } from '../../../shared/api/client';
import type {
  AddressInferenceReviewResponse,
  SuggestedNumber,
  TrainingAddress,
  TrainingMethod,
  TrainingStatus,
} from '../../../shared/api/types';
import AccountTabs, { ADMIN_PASSCODE_STORAGE_KEY } from '../components/AccountTabs';
import PageHeader from '../components/PageHeader';
import TrainingDataMap, {
  BUILDING_COLORS,
  PARCEL_COLOR,
  STATUS_COLORS,
  SUGGESTION_COLORS,
  type SuggestionKind,
  UNLISTED_COLOR,
  addressLabel,
  describe,
  describeSuggestion,
  suggestionKind,
} from '../components/TrainingDataMap';

// Owner-only: the building-address ML experiment's training data on a map
// (address_inference/ -- see docs/superpowers/specs/2026-11-02-building-
// address-inference-design.md). Every point is an E911 address the ranker
// was cross-validated on; colors say whether it picked the building E911
// says is that address. Same admin passcode as /owner, remembered in the
// same localStorage key.

const STATUS_LABELS: Record<TrainingStatus, string> = {
  right: 'Right building',
  wrong: 'Wrong building',
  missed: 'True building not a candidate',
  no_building: 'No building at the E911 point',
  estimated: 'Estimated point (no house)',
};
const METHOD_LABELS: Record<TrainingMethod, string> = {
  ml_order: 'ML + road order',
  ml: 'ML alone',
  ml_order_e911roads: 'E911 roads: ML + road order',
  ml_e911roads: 'E911 roads: ML alone',
  ml_order_auto: 'Auto list ranges: ML + road order',
  ml_auto: 'Auto list ranges: ML alone',
  ml_order_list: 'List ranges: ML + road order',
  ml_list: 'List ranges: ML alone',
  ml_order_ranges: 'Correct ranges: ML + road order',
  ml_ranges: 'Correct ranges: ML alone',
  assessor: "Assessor's lot address",
  assessor_e911roads: "E911 roads: assessor's lot address",
  pattern: 'Pattern (dead ends): park / townhouse / rural',
  pattern_ml: 'Pattern + ML membership (dead ends)',
};
const BASE_METHOD: Record<TrainingMethod, TrainingMethod> = {
  ml_order: 'ml',
  ml: 'ml',
  ml_order_e911roads: 'ml_e911roads',
  ml_e911roads: 'ml_e911roads',
  ml_order_auto: 'ml_auto',
  ml_auto: 'ml_auto',
  ml_order_list: 'ml_list',
  ml_list: 'ml_list',
  ml_order_ranges: 'ml_ranges',
  ml_ranges: 'ml_ranges',
  // compared against ML + road order, the pick it replaces
  assessor: 'ml_order',
  assessor_e911roads: 'ml_order_e911roads',
  // compared against the tax roll everywhere
  pattern: 'assessor',
  pattern_ml: 'assessor',
};
const isAssessorMethod = (m: TrainingMethod) => m.startsWith('assessor');
const isOrderMethod = (m: TrainingMethod) => BASE_METHOD[m] !== m;
const isPatternMethod = (m: TrainingMethod) => m.startsWith('pattern');
type StreetPattern = 'park' | 'townhouse' | 'rural';
const PATTERNS: { pattern: StreetPattern; label: string; color: string }[] = [
  { pattern: 'park', label: "Community park -> your drive rule", color: '#e6007e' },
  { pattern: 'townhouse', label: 'Townhouse complex -> ML + road order', color: '#e67e22' },
  { pattern: 'rural', label: 'Rural -> tax roll', color: '#2471a3' },
];
const PATTERN_LABEL: Record<StreetPattern, string> = { park: 'park', townhouse: 'townhouse', rural: 'rural' };
const PATTERN_METHOD_LABEL: Record<string, string> = {
  drive_rule: 'the drive rule (evens on the right going in, odds on the right coming back)',
  ml_order: 'ML + road order',
  assessor: "the tax roll's lot address, else ML + road order",
};
const STATUS_ORDER: TrainingStatus[] = ['wrong', 'missed', 'right', 'no_building', 'estimated'];
const LIST_LIMIT = 200;
const SUGGESTION_KINDS: { kind: SuggestionKind; label: string }[] = [
  { kind: 'second', label: 'Second house on a numbered lot' },
  { kind: 'lot', label: 'House on a lot with no E911 number' },
  { kind: 'none', label: 'No free number between its neighbors' },
];

function readPasscode(): string | null {
  try {
    return localStorage.getItem(ADMIN_PASSCODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

// A status dot with the unlisted ring, as the map draws it.
function UnlistedSwatch({ color = '#ffffff' }: { color?: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: color,
        border: `3px solid ${UNLISTED_COLOR}`,
        marginRight: 6,
        verticalAlign: '-2px',
        flex: 'none',
      }}
    />
  );
}

function Swatch({ color, square = false }: { color: string; square?: boolean }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 12,
        height: 12,
        borderRadius: square ? 2 : '50%',
        background: color,
        opacity: square ? 0.7 : 1,
        marginRight: 6,
        verticalAlign: '-1px',
        flex: 'none',
      }}
    />
  );
}

export default function TrainingData() {
  const [passcode, setPasscode] = useState<string | null>(readPasscode);
  const [passcodeInput, setPasscodeInput] = useState('');
  const [town, setTown] = useState<string | null>(null);
  const [method, setMethod] = useState<TrainingMethod>('ml_order');
  const [changedOnly, setChangedOnly] = useState(false);
  const [unlistedOnly, setUnlistedOnly] = useState(false);
  const [shownPatterns, setShownPatterns] = useState<Set<StreetPattern>>(() => new Set(['park', 'townhouse', 'rural']));
  const [data, setData] = useState<AddressInferenceReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState<Set<TrainingStatus>>(() => new Set(['wrong', 'missed', 'estimated']));
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<TrainingAddress | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [showParcels, setShowParcels] = useState(true);
  const [shownKinds, setShownKinds] = useState<Set<SuggestionKind>>(() => new Set(['second', 'lot', 'none']));
  const [selectedSuggestion, setSelectedSuggestion] = useState<SuggestedNumber | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const mapBoxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (key: string, townName: string | null, methodName: TrainingMethod) => {
    setLoading(true);
    setError(null);
    try {
      setData(await getAddressInferenceReview(key, townName, methodName));
      setSelected(null);
      setSelectedSuggestion(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Incorrect passcode.');
        try {
          localStorage.removeItem(ADMIN_PASSCODE_STORAGE_KEY);
        } catch {
          // storage unavailable: nothing remembered to clear
        }
        setPasscode(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not load the training data.');
      }
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (passcode) load(passcode, town, method);
  }, [passcode, town, method, load]);

  const unlock = () => {
    const trimmed = passcodeInput.trim();
    if (!trimmed) return;
    try {
      localStorage.setItem(ADMIN_PASSCODE_STORAGE_KEY, trimmed);
    } catch {
      // still works for this visit
    }
    setPasscode(trimmed);
  };

  const toggle = (status: TrainingStatus) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });

  const listed = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toUpperCase();
    return data.addresses
      .filter((a) => visible.has(a.status))
      .filter((a) => !changedOnly || a.changedFromMl)
      .filter((a) => !unlistedOnly || a.taxRoll === false)
      .filter((a) => !isPatternMethod(data.method) || !a.pattern || shownPatterns.has(a.pattern))
      .filter((a) => !needle || addressLabel(a).toUpperCase().includes(needle))
      .sort((a, b) => b.errorMeters - a.errorMeters);
  }, [data, visible, search, changedOnly, unlistedOnly, shownPatterns]);

  // The map shows the same addresses as the list's status + changed + unlisted filters.
  const mapData = useMemo(
    () => {
      const patternOk = (a: TrainingAddress) =>
        !data || !isPatternMethod(data.method) || !a.pattern || shownPatterns.has(a.pattern);
      return data && (changedOnly || unlistedOnly || isPatternMethod(data.method))
        ? {
            ...data,
            addresses: data.addresses.filter(
              (a) => (!changedOnly || a.changedFromMl) && (!unlistedOnly || a.taxRoll === false) && patternOk(a)
            ),
          }
        : data;
    },
    [data, changedOnly, unlistedOnly, shownPatterns]
  );
  // Pattern method: per pattern, streets and street numbers (each once) right.
  const patternCounts = useMemo(() => {
    const out: Record<StreetPattern, { streets: Set<string>; numbers: Map<string, boolean> }> = {
      park: { streets: new Set(), numbers: new Map() },
      townhouse: { streets: new Set(), numbers: new Map() },
      rural: { streets: new Set(), numbers: new Map() },
    };
    for (const a of data?.addresses ?? []) {
      if (!a.pattern) continue;
      const bucket = out[a.pattern];
      bucket.streets.add(a.street);
      if (a.status === 'no_building') continue;
      const key = `${a.street}|${a.number}`;
      bucket.numbers.set(key, (bucket.numbers.get(key) ?? false) || a.status === 'right');
    }
    return out;
  }, [data]);
  // Assessor methods: the E911 numbers the tax roll doesn't list, which fall
  // back to ML + road order. Counted per point and per street number.
  const unlistedCounts = useMemo(() => {
    const unlisted = (data?.addresses ?? []).filter((a) => a.taxRoll === false);
    const labelled = unlisted.filter((a) => a.status !== 'no_building');
    const right = labelled.filter((a) => a.status === 'right').length;
    return {
      points: unlisted.length,
      numbers: new Set(unlisted.map((a) => `${a.street}|${a.number}`)).size,
      byStatus: Object.fromEntries(STATUS_ORDER.map((st) => [st, unlisted.filter((a) => a.status === st).length])) as Record<
        TrainingStatus,
        number
      >,
      rightShare: labelled.length ? `${((100 * right) / labelled.length).toFixed(1)}%` : '–',
    };
  }, [data]);
  const changedCounts = useMemo(() => {
    const changed = (data?.addresses ?? []).filter((a) => a.changedFromMl);
    return {
      total: changed.length,
      fixed: changed.filter((a) => a.status === 'right').length,
      broke: changed.filter((a) => a.mlStatus === 'right').length,
    };
  }, [data]);

  const sqmeters = useMemo(
    () => new Map((data?.buildings.features ?? []).map((f) => [f.properties.id, f.properties.sqmeters])),
    [data]
  );

  const allSuggestions = useMemo(() => data?.suggestions ?? [], [data]);
  const kindCounts = useMemo(() => {
    const counts: Record<SuggestionKind, number> = { second: 0, lot: 0, none: 0 };
    for (const sg of allSuggestions) counts[suggestionKind(sg)] += 1;
    return counts;
  }, [allSuggestions]);
  const suggestions = useMemo(
    () => allSuggestions.filter((sg) => shownKinds.has(suggestionKind(sg))),
    [allSuggestions, shownKinds]
  );
  const toggleKind = (kind: SuggestionKind) =>
    setShownKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  const listedSuggestions = useMemo(() => {
    const needle = search.trim().toUpperCase();
    return suggestions.filter(
      (s) => !needle || `${s.number ?? ''} ${s.street}`.toUpperCase().includes(needle)
    );
  }, [suggestions, search]);
  const selectAddress = (a: TrainingAddress) => {
    setSelectedSuggestion(null);
    setSelected(a);
  };
  const selectSuggestion = (s: SuggestedNumber) => {
    setSelected(null);
    setSelectedSuggestion(s);
  };

  const total = data?.addresses.length ?? 0;
  // Same base as evaluate's report: each street number counts once (141
  // Main Street's 563 E911 points weigh as one address), and right/wrong/
  // missed are shares of the numbers whose points HAVE a building at the
  // E911 point; "no building" is a share of all of them. The big number on
  // each card is still the count of E911 points.
  const weightedShare = useMemo(() => {
    const perNumber = new Map<string, number>();
    for (const a of data?.addresses ?? []) {
      const key = `${a.street}|${a.number}`;
      perNumber.set(key, (perNumber.get(key) ?? 0) + 1);
    }
    const sums: Record<string, number> = {};
    let all = 0;
    let labelledWeight = 0;
    for (const a of data?.addresses ?? []) {
      const w = 1 / (perNumber.get(`${a.street}|${a.number}`) ?? 1);
      sums[a.status] = (sums[a.status] ?? 0) + w;
      all += w;
      if (a.status !== 'no_building') labelledWeight += w;
    }
    return (status: TrainingStatus) => {
      const base = status === 'no_building' ? all : labelledWeight;
      return base ? `${((100 * (sums[status] ?? 0)) / base).toFixed(1)}%` : '';
    };
  }, [data]);
  const estimatedWithin = useMemo(() => {
    const best = new Map<string, number>();
    for (const a of data?.addresses ?? []) {
      if (a.status !== 'estimated') continue;
      const key = `${a.street}|${a.number}`;
      best.set(key, Math.min(best.get(key) ?? Infinity, a.errorMeters));
    }
    const all = [...best.values()];
    return { n: all.length, m25: all.filter((e) => e <= 25).length, m50: all.filter((e) => e <= 50).length };
  }, [data]);
  const share = (status: TrainingStatus) =>
    status === 'estimated'
      ? `${estimatedWithin.m25}/${estimatedWithin.n} within 25 m, ${estimatedWithin.m50} within 50 m`
      : weightedShare(status);

  return (
    <div>
      <PageHeader icon="findPlaces">Training data</PageHeader>
      <AccountTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)', maxWidth: 760 }}>
        Building-address experiment: every point is a Maine E911 address the ML ranker trained and was tested on
        (cross-validated by street, so each pick comes from a model that never saw that street). The color shows
        whether it picked the building E911 says is that address. "ML + road order" keeps one building per number
        and numbers increasing along the road, per street and side. "Correct ranges" is an upper-bound experiment:
        TIGER's house-number ranges replaced by the real E911 numbers' range on each segment side (what a
        correctly-numbered road file would give). "List ranges" uses only the address list's own min..max per
        street side, never TIGER's numbers; "Auto" does that only where TIGER's range looks like a placeholder
        for sequentially-numbered houses. "Assessor's lot address" gives each address the biggest building on the tax lot
        whose assessor address (the town's tax roll) is the same number and street, else the ML + road order pick -- the
        tax roll is never a model input. "E911 roads" uses Maine's E911 road centerlines instead of TIGER (restricted
        source, internal verification only). Owner only, not linked for visitors.
      </p>

      {!passcode && (
        <div className="card elev-sm" style={{ maxWidth: 480 }}>
          <div className="field">
            <label>Admin passcode</label>
            <input
              className="input"
              type="password"
              value={passcodeInput}
              onChange={(e) => setPasscodeInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && unlock()}
              autoFocus
            />
          </div>
          {error && <p style={{ color: '#a4402a', margin: '0 0 var(--space-3)' }}>{error}</p>}
          <button className="btn btn-primary" onClick={unlock}>
            Unlock
          </button>
        </div>
      )}

      {passcode && error && <p style={{ color: '#a4402a' }}>{error}</p>}
      {passcode && loading && !data && <p className="text-muted">Loading training data…</p>}

      {passcode && data && (
        <>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-3)',
              alignItems: 'center',
              marginBottom: 'var(--space-3)',
            }}
          >
            {data.towns.length > 1 ? (
              <select className="input" style={{ width: 'auto' }} value={data.town} onChange={(e) => setTown(e.target.value)}>
                {data.towns.map((t) => (
                  <option key={t.town} value={t.town}>
                    {t.town}
                  </option>
                ))}
              </select>
            ) : (
              <strong>{data.town}</strong>
            )}
            <span className="text-muted">
              {total.toLocaleString()} addresses · run {data.runDate}
              {loading ? ' · refreshing…' : ''}
            </span>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }} role="group" aria-label="Method">
              {(data.methods ?? ['ml_order', 'ml']).map((m) => (
                <button
                  key={m}
                  className={`btn ${method === m ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    setMethod(m);
                    if (!isOrderMethod(m)) setChangedOnly(false);
                    if (!isAssessorMethod(m)) setUnlistedOnly(false);
                  }}
                  disabled={loading}
                >
                  {METHOD_LABELS[m]}
                </button>
              ))}
            </div>
          </div>
          {isOrderMethod(data.method) && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 'var(--space-3)' }}>
              <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
              <span>
                Only addresses where{' '}
                {isPatternMethod(data.method)
                  ? "the street's pattern"
                  : isAssessorMethod(data.method)
                    ? "the assessor's lot address"
                    : 'road order'}{' '}
                changed
                the pick ({changedCounts.total.toLocaleString()}:{' '}
                <span style={{ color: STATUS_COLORS.right }}>{changedCounts.fixed.toLocaleString()} now right</span>,{' '}
                <span style={{ color: STATUS_COLORS.wrong }}>{changedCounts.broke.toLocaleString()} were right before</span>)
              </span>
            </label>
          )}

          {isPatternMethod(data.method) && (
            <div className="card elev-sm" style={{ margin: '0 0 var(--space-3)' }}>
              <div className="card-kicker" style={{ margin: 0 }}>
                Dead-end streets only, each numbered by its kind of place
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', marginTop: 'var(--space-2)' }}>
                {PATTERNS.map(({ pattern, label, color }) => {
                  const c = patternCounts[pattern];
                  const right = [...c.numbers.values()].filter(Boolean).length;
                  return (
                    <label
                      key={pattern}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', opacity: shownPatterns.has(pattern) ? 1 : 0.55 }}
                    >
                      <input
                        type="checkbox"
                        checked={shownPatterns.has(pattern)}
                        onChange={() =>
                          setShownPatterns((prev) => {
                            const next = new Set(prev);
                            if (next.has(pattern)) next.delete(pattern);
                            else next.add(pattern);
                            return next;
                          })
                        }
                      />
                      <Swatch color={color} square />
                      <span>
                        {label}:{' '}
                        <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {right}/{c.numbers.size}
                        </strong>{' '}
                        numbers right ({c.streets.size} streets)
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="text-muted" style={{ fontSize: 13, marginTop: 4 }}>
                A park is a community whose homes share one big tax lot (half its buildings on a lot with more than 3)
                and about one building per number; a townhouse complex has more than 1.5 numbers per building.
                {data.method === 'pattern_ml'
                  ? ' Here the drive rule only uses the buildings a machine-learning model says belong to the street (gaps to neighbours, setback, the other road, size), not every building whose nearest road is the street.'
                  : ''}{' '}
                Tick
                "where ... changed the pick" below to see only where this differs from the tax roll everywhere.
              </div>
            </div>
          )}

          {isAssessorMethod(data.method) && unlistedCounts.points > 0 && (
            <div className="card elev-sm" style={{ margin: '0 0 var(--space-3)' }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input type="checkbox" checked={unlistedOnly} onChange={(e) => setUnlistedOnly(e.target.checked)} />
                <UnlistedSwatch />
                <span>
                  Only numbers the tax roll doesn't list:{' '}
                  <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {unlistedCounts.numbers.toLocaleString()} numbers
                  </strong>{' '}
                  ({unlistedCounts.points.toLocaleString()} E911 points; {unlistedCounts.rightShare} of points with a building
                  right)
                </span>
              </label>
              <div className="text-muted" style={{ fontSize: 13, marginTop: 4 }}>
                No tax lot with that number and street (with a building on it), so the pick fell back to ML + road order.
                Ringed in magenta on the map whether or not this is ticked:{' '}
                {STATUS_ORDER.map((st, i) => (
                  <span key={st}>
                    {i > 0 ? ' · ' : ''}
                    <span style={{ color: STATUS_COLORS[st] }}>
                      {unlistedCounts.byStatus[st].toLocaleString()} {STATUS_LABELS[st].toLowerCase()}
                    </span>
                  </span>
                ))}
                . The status checkboxes below still apply.
              </div>
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 'var(--space-3)',
              marginBottom: 'var(--space-4)',
            }}
          >
            {STATUS_ORDER.filter((status) => status !== 'estimated' || (data.summary.estimated ?? 0) > 0).map((status) => {
              const n = data.summary[status] ?? 0;
              return (
                <label
                  key={status}
                  className="card elev-sm"
                  style={{ cursor: 'pointer', opacity: visible.has(status) ? 1 : 0.55, margin: 0 }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={visible.has(status)} onChange={() => toggle(status)} />
                    <Swatch color={STATUS_COLORS[status]} />
                    <span className="card-kicker" style={{ margin: 0 }}>
                      {STATUS_LABELS[status]}
                    </span>
                  </div>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>
                    {n.toLocaleString()}{' '}
                    <span className="text-muted" style={{ fontSize: 14 }}>
                      {share(status)}
                      {status === 'estimated' ? '' : ' of numbers'}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>

          {allSuggestions.length > 0 && (
            <div className="card elev-sm" style={{ margin: '0 0 var(--space-4)', opacity: showSuggestions ? 1 : 0.55 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showSuggestions}
                  onChange={(e) => {
                    setShowSuggestions(e.target.checked);
                    if (!e.target.checked) setSelectedSuggestion(null);
                  }}
                />
                <span className="card-kicker" style={{ margin: 0 }}>
                  {allSuggestions.length.toLocaleString()} houses with no E911 point (suggested numbers, not E911)
                </span>
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', marginTop: 'var(--space-2)' }}>
                {SUGGESTION_KINDS.map(({ kind, label }) => (
                  <label
                    key={kind}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      cursor: 'pointer',
                      opacity: shownKinds.has(kind) ? 1 : 0.55,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={shownKinds.has(kind)}
                      disabled={!showSuggestions}
                      onChange={() => toggleKind(kind)}
                    />
                    <Swatch color={SUGGESTION_COLORS[kind]} square />
                    <span>
                      {label}{' '}
                      <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{kindCounts[kind].toLocaleString()}</strong>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div
            className="text-muted"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', fontSize: 13, marginBottom: 'var(--space-2)' }}
          >
            <span>
              <Swatch color={BUILDING_COLORS.truth} square />
              E911 building
            </span>
            <span>
              <Swatch color={BUILDING_COLORS.wrongPick} square />
              Wrongly picked building
            </span>
            <span>
              <Swatch color={BUILDING_COLORS.both} square />
              Both (one address's truth, another's wrong pick)
            </span>
            <span>
              <Swatch color={BUILDING_COLORS.other} square />
              Other footprints
            </span>
            {allSuggestions.length > 0 && (
              <span>Colored footprint + dot: a house with no E911 point (click the dot; dashed = no free number)</span>
            )}
            <span>Dashed line: E911 point → picked building · white ring: today's interpolation</span>
            {(isAssessorMethod(data.method) || isPatternMethod(data.method)) && unlistedCounts.points > 0 && (
              <span>
                <UnlistedSwatch />
                Magenta ring: number the tax roll doesn't list
              </span>
            )}
            {(data.parcels?.features.length ?? 0) > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showParcels} onChange={(e) => setShowParcels(e.target.checked)} />
                <Swatch color={PARCEL_COLOR} square />
                Tax lots ({data.parcels!.features.length.toLocaleString()}; click inside one for its tax-roll address)
              </label>
            )}
          </div>

          <div ref={mapBoxRef} style={{ scrollMarginTop: 'var(--space-4)', position: 'relative' }}>
            {/* Search over the map's top-left corner (zoom buttons are top-right):
                no scrolling down to the table on a small screen. Same filter as the table. */}
            <div
              className="card elev-sm"
              style={{
                position: 'absolute',
                top: 8,
                left: 8,
                zIndex: 2,
                width: 'min(280px, calc(100% - 64px))',
                padding: 6,
                margin: 0,
              }}
            >
              <input
                className="input"
                style={{ width: '100%' }}
                placeholder="Find an address, e.g. 33 HARRASEEKET"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Find an address on the map"
              />
              {search.trim() !== '' && (
                <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 4, fontSize: 13 }}>
                  {listed.length === 0 && (
                    <div className="text-muted" style={{ padding: '4px 6px' }}>
                      No match among the results ticked above
                    </div>
                  )}
                  {listed.slice(0, 8).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => {
                        selectAddress(a);
                        setFocusNonce((n) => n + 1);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        width: '100%',
                        textAlign: 'left',
                        padding: '4px 6px',
                        border: 0,
                        borderRadius: 4,
                        cursor: 'pointer',
                        color: 'inherit',
                        font: 'inherit',
                        background: selected?.id === a.id ? 'var(--color-accent-100)' : 'transparent',
                      }}
                    >
                      <Swatch color={STATUS_COLORS[a.status]} />
                      {addressLabel(a)}
                    </button>
                  ))}
                  {listed.length > 8 && (
                    <div className="text-muted" style={{ padding: '4px 6px' }}>
                      {listed.length - 8} more in the table below
                    </div>
                  )}
                </div>
              )}
            </div>
            <TrainingDataMap
              data={mapData ?? data}
              visible={visible}
              selected={selected}
              focusNonce={focusNonce}
              onSelect={selectAddress}
              suggestions={showSuggestions ? suggestions : []}
              selectedSuggestion={selectedSuggestion}
              onSelectSuggestion={selectSuggestion}
              showParcels={showParcels}
            />
          </div>

          {selectedSuggestion && (
            <div className="card elev-sm" style={{ marginTop: 'var(--space-3)' }}>
              <div>{describeSuggestion(selectedSuggestion)}</div>
              <div className="text-muted" style={{ fontSize: 13, marginTop: 4 }}>
                Building {selectedSuggestion.building}
                {sqmeters.get(selectedSuggestion.building) != null
                  ? ` (${sqmeters.get(selectedSuggestion.building)} m² outline)`
                  : ''}
                . Numbers on one side of a street share a parity and run in order by distance, so this is the free
                number nearest to where the house falls between its neighbors.
              </div>
            </div>
          )}

          {selected && (
            <div className="card elev-sm" style={{ marginTop: 'var(--space-3)' }}>
              <div>{describe(selected)}</div>
              {isOrderMethod(data.method) && (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  {selected.changedFromMl
                    ? `${isPatternMethod(data.method) ? "The street's pattern" : isAssessorMethod(data.method) ? "The assessor's lot address" : 'Road order'} changed the pick. With the tax roll everywhere instead: ${STATUS_LABELS[selected.mlStatus].toLowerCase()}.`
                    : 'Same pick as ML alone.'}
                </div>
              )}
              {selected.pattern && (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  <Swatch color={PATTERNS.find((p) => p.pattern === selected.pattern)!.color} square />
                  {selected.street} is a {PATTERN_LABEL[selected.pattern]} street, numbered by{' '}
                  {PATTERN_METHOD_LABEL[selected.patternMethod ?? ''] ?? selected.patternMethod}.
                </div>
              )}
              {selected.taxRoll === false && (
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  <UnlistedSwatch color={STATUS_COLORS[selected.status]} />
                  The tax roll doesn't list this number on this street, so this is the ML + road order pick.
                </div>
              )}
              {selected.placement && (
                <div className="text-muted" style={{ fontSize: 13, marginTop: 4 }}>
                  E911 placement: {selected.placement}
                  {!selected.placement.startsWith('Structure') ? ' (not placed on a building)' : ''}
                </div>
              )}
              <div className="text-muted" style={{ fontSize: 13, marginTop: 4 }}>
                E911 building: {selected.trueBuilding ?? 'none'}
                {selected.trueBuilding && sqmeters.get(selected.trueBuilding) != null
                  ? ` (${sqmeters.get(selected.trueBuilding)} m²)`
                  : ''}{' '}
                · picked: {selected.pickedBuilding ?? 'none (fell back to interpolation)'}
                {selected.pickedBuilding && sqmeters.get(selected.pickedBuilding) != null
                  ? ` (${sqmeters.get(selected.pickedBuilding)} m²)`
                  : ''}
              </div>
            </div>
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--space-3)',
              margin: 'var(--space-5) 0 var(--space-3)',
            }}
          >
            <h4 style={{ margin: 0 }}>
              Addresses{' '}
              <span className="text-muted" style={{ fontWeight: 400 }}>
                ({listed.length.toLocaleString()}, farthest off first
                {listed.length > LIST_LIMIT ? `; showing ${LIST_LIMIT}` : ''})
              </span>
            </h4>
            <input
              className="input"
              style={{ maxWidth: 260 }}
              placeholder="Filter, e.g. MAIN ST or UNIT 14"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Result</th>
                  <th>Off by</th>
                  {isOrderMethod(data.method) && (
                    <th>
                      {isPatternMethod(data.method)
                        ? 'Tax roll everywhere'
                        : isAssessorMethod(data.method)
                          ? 'ML + road order'
                          : 'Without road order'}
                    </th>
                  )}
                  <th>Candidates</th>
                </tr>
              </thead>
              <tbody>
                {listed.slice(0, LIST_LIMIT).map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => {
                      selectAddress(a);
                      setFocusNonce((n) => n + 1);
                      mapBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    style={{
                      cursor: 'pointer',
                      background: selected?.id === a.id ? 'var(--color-accent-100)' : undefined,
                    }}
                  >
                    <td>
                      {addressLabel(a)}
                      {a.pattern && a.pattern !== 'rural' && (
                        <span
                          className="tag tag-neutral"
                          style={{
                            marginLeft: 6,
                            borderColor: PATTERNS.find((p) => p.pattern === a.pattern)!.color,
                            color: PATTERNS.find((p) => p.pattern === a.pattern)!.color,
                          }}
                        >
                          {PATTERN_LABEL[a.pattern]}
                        </span>
                      )}
                      {a.taxRoll === false && (
                        <span
                          className="tag tag-neutral"
                          style={{ marginLeft: 6, borderColor: UNLISTED_COLOR, color: UNLISTED_COLOR }}
                          title="The tax roll doesn't list this number on this street"
                        >
                          not on tax roll
                        </span>
                      )}
                      {a.placement && !a.placement.startsWith('Structure') && (
                        <span className="tag tag-neutral" style={{ marginLeft: 6 }} title="How E911 placed this point">
                          {a.placement}
                        </span>
                      )}
                    </td>
                    <td>
                      <Swatch color={STATUS_COLORS[a.status]} />
                      {STATUS_LABELS[a.status]}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{a.errorMeters.toLocaleString()} m</td>
                    {isOrderMethod(data.method) && (
                      <td className="text-muted">{a.changedFromMl ? STATUS_LABELS[a.mlStatus] : 'same pick'}</td>
                    )}
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{a.candidates}</td>
                  </tr>
                ))}
                {listed.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-muted">
                      Nothing matches -- tick a category above or clear the filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {showSuggestions && allSuggestions.length > 0 && (
            <>
              <h4 style={{ margin: 'var(--space-5) 0 var(--space-3)' }}>
                Suggested numbers{' '}
                <span className="text-muted" style={{ fontWeight: 400 }}>
                  ({listedSuggestions.length.toLocaleString()}
                  {listedSuggestions.length > LIST_LIMIT ? `; showing ${LIST_LIMIT}` : ''}; same filter as above)
                </span>
              </h4>
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Suggested</th>
                      <th>House</th>
                      <th>Neighbors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listedSuggestions.slice(0, LIST_LIMIT).map((sg) => (
                      <tr
                        key={sg.building}
                        onClick={() => {
                          selectSuggestion(sg);
                          mapBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                        style={{
                          cursor: 'pointer',
                          background: selectedSuggestion?.building === sg.building ? 'var(--color-accent-100)' : undefined,
                        }}
                      >
                        <td>
                          {sg.number != null ? (
                            `${sg.number} ${sg.street}`
                          ) : (
                            <span className="text-muted">none on {sg.street}</span>
                          )}
                        </td>
                        <td>
                          <Swatch color={SUGGESTION_COLORS[suggestionKind(sg)]} square />
                          {sg.tier === 'second house' ? 'Second house on a numbered lot' : 'Lot with no number'}
                        </td>
                        <td className="text-muted">
                          {sg.number != null
                            ? [sg.before, sg.after].filter((n) => n != null).join(' – ') || '—'
                            : sg.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
