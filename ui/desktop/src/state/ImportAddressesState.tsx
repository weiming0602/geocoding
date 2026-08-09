import { createContext, useContext, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';

import type { ColumnRole } from '../pages/ImportAddresses';

export type Step = 'upload' | 'map' | 'preview';
export type StatusFilter = 'all' | 'valid' | 'flagged';
export const ALL_FILTER_VALUE = '__all__';

type ImportAddressesStateValue = {
  step: Step;
  setStep: Dispatch<SetStateAction<Step>>;
  fileName: string;
  setFileName: Dispatch<SetStateAction<string>>;
  headers: string[];
  setHeaders: Dispatch<SetStateAction<string[]>>;
  rows: string[][];
  setRows: Dispatch<SetStateAction<string[][]>>;
  hasHeaderRow: boolean;
  setHasHeaderRow: Dispatch<SetStateAction<boolean>>;
  mapping: Record<number, ColumnRole>;
  setMapping: Dispatch<SetStateAction<Record<number, ColumnRole>>>;
  included: boolean[];
  setIncluded: Dispatch<SetStateAction<boolean[]>>;
  statusFilter: StatusFilter;
  setStatusFilter: Dispatch<SetStateAction<StatusFilter>>;
  columnFilters: Record<number, string>;
  setColumnFilters: Dispatch<SetStateAction<Record<number, string>>>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
};

const ImportAddressesStateContext = createContext<ImportAddressesStateValue | null>(null);

// Lives above the router (wrapped around <Routes> in App.tsx) instead of
// as local state in ImportAddresses.tsx, so navigating away -- e.g. "Send
// to Batch geocode", then "Back to Import Addresses" from Batch -- lands
// back exactly where the user left off (same file, mapping, filters, and
// row selection), not a reset wizard. A user comparing a few different
// filtered selections before committing to Batch geocode shouldn't have
// to redo the upload/mapping step each time they go back and forth.
export function ImportAddressesStateProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<Step>('upload');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [hasHeaderRow, setHasHeaderRow] = useState(true);
  const [mapping, setMapping] = useState<Record<number, ColumnRole>>({});
  const [included, setIncluded] = useState<boolean[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [columnFilters, setColumnFilters] = useState<Record<number, string>>({});
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <ImportAddressesStateContext.Provider
      value={{
        step,
        setStep,
        fileName,
        setFileName,
        headers,
        setHeaders,
        rows,
        setRows,
        hasHeaderRow,
        setHasHeaderRow,
        mapping,
        setMapping,
        included,
        setIncluded,
        statusFilter,
        setStatusFilter,
        columnFilters,
        setColumnFilters,
        search,
        setSearch,
        error,
        setError,
      }}
    >
      {children}
    </ImportAddressesStateContext.Provider>
  );
}

export function useImportAddressesState() {
  const ctx = useContext(ImportAddressesStateContext);
  if (!ctx) throw new Error('useImportAddressesState must be used within ImportAddressesStateProvider');
  return ctx;
}
