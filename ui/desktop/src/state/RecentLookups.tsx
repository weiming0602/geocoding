import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';

export type RecentLookup = {
  address: string;
  latitude: number;
  longitude: number;
  // Absent for an exact Maine E911 address-point match -- rangeSide only
  // describes an *estimated* position along a street segment, which
  // doesn't apply when the point itself is already known exactly.
  rangeSide?: 'left' | 'right';
};

const STORAGE_KEY = 'meridian.recentLookups';
const MAX_ENTRIES = 6;

function loadInitial(): RecentLookup[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RecentLookup[]) : [];
  } catch {
    return [];
  }
}

type RecentLookupsContextValue = {
  recentLookups: RecentLookup[];
  addLookup: (lookup: RecentLookup) => void;
};

const RecentLookupsContext = createContext<RecentLookupsContextValue | null>(null);

// Overview's "recent activity" table and the Geocode/Reverse geocode
// screens' "recent lookups" lists all read from the same real,
// session-local history -- there's no request-logging backend to source
// this from (see the design handoff's now-corrected README), so this is
// genuinely real data (what you've actually looked up this browser
// session) rather than the mockup's seeded example rows.
export function RecentLookupsProvider({ children }: { children: ReactNode }) {
  const [recentLookups, setRecentLookups] = useState<RecentLookup[]>(loadInitial);

  const addLookup = useCallback((lookup: RecentLookup) => {
    setRecentLookups((prev) => {
      const next = [lookup, ...prev].slice(0, MAX_ENTRIES);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // localStorage unavailable (private browsing, quota) -- in-memory only is fine.
      }
      return next;
    });
  }, []);

  return (
    <RecentLookupsContext.Provider value={{ recentLookups, addLookup }}>
      {children}
    </RecentLookupsContext.Provider>
  );
}

export function useRecentLookups() {
  const ctx = useContext(RecentLookupsContext);
  if (!ctx) throw new Error('useRecentLookups must be used within RecentLookupsProvider');
  return ctx;
}
