import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, getAddressInferenceReview } from '../../../shared/api/client';
import type { AddressInferenceReviewResponse, TrainingAddress, TrainingStatus } from '../../../shared/api/types';
import AccountTabs, { ADMIN_PASSCODE_STORAGE_KEY } from '../components/AccountTabs';
import PageHeader from '../components/PageHeader';
import TrainingDataMap, { BUILDING_COLORS, STATUS_COLORS, describe } from '../components/TrainingDataMap';

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
const STATUS_ORDER: TrainingStatus[] = ['wrong', 'missed', 'right', 'no_building'];
const LIST_LIMIT = 200;

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
  const [data, setData] = useState<AddressInferenceReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState<Set<TrainingStatus>>(() => new Set(['wrong', 'missed']));
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<TrainingAddress | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const mapBoxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (key: string, townName: string | null) => {
    setLoading(true);
    setError(null);
    try {
      setData(await getAddressInferenceReview(key, townName));
      setSelected(null);
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
    if (passcode) load(passcode, town);
  }, [passcode, town, load]);

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
      .filter((a) => !needle || `${a.number} ${a.street}`.includes(needle))
      .sort((a, b) => b.errorMeters - a.errorMeters);
  }, [data, visible, search]);

  const sqmeters = useMemo(
    () => new Map((data?.buildings.features ?? []).map((f) => [f.properties.id, f.properties.sqmeters])),
    [data]
  );

  const total = data?.addresses.length ?? 0;

  return (
    <div>
      <PageHeader icon="findPlaces">Training data</PageHeader>
      <AccountTabs />
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)', maxWidth: 760 }}>
        Building-address experiment: every point is a Maine E911 address the ML ranker trained and was tested on
        (cross-validated by street, so each pick comes from a model that never saw that street). The color shows
        whether it picked the building E911 says is that address. Owner only, not linked for visitors.
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
          </div>

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
                      {total ? `${((100 * n) / total).toFixed(1)}%` : ''}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>

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
            <span>Dashed line: E911 point → picked building · white ring: today's interpolation</span>
          </div>

          <div ref={mapBoxRef} style={{ scrollMarginTop: 'var(--space-4)' }}>
            <TrainingDataMap
              data={data}
              visible={visible}
              selected={selected}
              focusNonce={focusNonce}
              onSelect={setSelected}
            />
          </div>

          {selected && (
            <div className="card elev-sm" style={{ marginTop: 'var(--space-3)' }}>
              <div>{describe(selected)}</div>
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
              placeholder="Filter by street, e.g. MAIN ST"
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
                  <th>Candidates</th>
                </tr>
              </thead>
              <tbody>
                {listed.slice(0, LIST_LIMIT).map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => {
                      setSelected(a);
                      setFocusNonce((n) => n + 1);
                      mapBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    style={{
                      cursor: 'pointer',
                      background: selected?.id === a.id ? 'var(--color-accent-100)' : undefined,
                    }}
                  >
                    <td>
                      {a.number} {a.street}
                    </td>
                    <td>
                      <Swatch color={STATUS_COLORS[a.status]} />
                      {STATUS_LABELS[a.status]}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{a.errorMeters.toLocaleString()} m</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{a.candidates}</td>
                  </tr>
                ))}
                {listed.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-muted">
                      Nothing matches -- tick a category above or clear the filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
