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
};
const isAssessorMethod = (m: TrainingMethod) => m.startsWith('assessor');
const isOrderMethod = (m: TrainingMethod) => BASE_METHOD[m] !== m;
const STATUS_ORDER: TrainingStatus[] = ['wrong', 'missed', 'right', 'no_building'];
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
  const [data, setData] = useState<AddressInferenceReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState<Set<TrainingStatus>>(() => new Set(['wrong', 'missed']));
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
      .filter((a) => !needle || addressLabel(a).toUpperCase().includes(needle))
      .sort((a, b) => b.errorMeters - a.errorMeters);
  }, [data, visible, search, changedOnly]);

  // The map shows the same addresses as the list's status + changed filters.
  const mapData = useMemo(
    () => (data && changedOnly ? { ...data, addresses: data.addresses.filter((a) => a.changedFromMl) } : data),
    [data, changedOnly]
  );
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
  const share = (status: TrainingStatus) => weightedShare(status);

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
                Only addresses where {isAssessorMethod(data.method) ? "the assessor's lot address" : 'road order'} changed
                the pick ({changedCounts.total.toLocaleString()}:{' '}
                <span style={{ color: STATUS_COLORS.right }}>{changedCounts.fixed.toLocaleString()} now right</span>,{' '}
                <span style={{ color: STATUS_COLORS.wrong }}>{changedCounts.broke.toLocaleString()} were right before</span>)
              </span>
            </label>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 'var(--space-3)',
              marginBottom: 'var(--space-4)',
            }}
          >
            {STATUS_ORDER.map((status) => {
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
                      {share(status)} of numbers
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
            {(data.parcels?.features.length ?? 0) > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showParcels} onChange={(e) => setShowParcels(e.target.checked)} />
                <Swatch color={PARCEL_COLOR} square />
                Tax lots ({data.parcels!.features.length.toLocaleString()}; click inside one for its tax-roll address)
              </label>
            )}
          </div>

          <div ref={mapBoxRef} style={{ scrollMarginTop: 'var(--space-4)' }}>
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
                    ? `${isAssessorMethod(data.method) ? "The assessor's lot address" : 'Road order'} changed the pick. Without it: ${STATUS_LABELS[selected.mlStatus].toLowerCase()}.`
                    : 'Same pick as ML alone.'}
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
                    <th>{isAssessorMethod(data.method) ? 'ML + road order' : 'Without road order'}</th>
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
