import { useEffect, useState, useSyncExternalStore } from "react";

export type RecentRecordKind =
  | "item"
  | "customer"
  | "supplier"
  | "sales_order"
  | "purchase_order";

export interface RecentRecord {
  kind: RecentRecordKind;
  id: number;
  title: string;
  subtitle?: string;
  href: string;
  visitedAt: number;
}

export const MAX_RECENT_RECORDS = 5;
const STORAGE_KEY = "mystics:recent-records:v1";
const STORAGE_EVENT = "mystics:recent-records:changed";

function readFromStorage(): RecentRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRecord).slice(0, MAX_RECENT_RECORDS);
  } catch {
    return [];
  }
}

function isValidRecord(value: unknown): value is RecentRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.kind === "string" &&
    typeof r.id === "number" &&
    typeof r.title === "string" &&
    typeof r.href === "string" &&
    typeof r.visitedAt === "number"
  );
}

function writeToStorage(records: RecentRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    window.dispatchEvent(new Event(STORAGE_EVENT));
  } catch {
    // Storage may be unavailable (private mode, quota exceeded). Silent
    // failure is fine — recents are a convenience, not critical state.
  }
}

export function getRecentRecords(): RecentRecord[] {
  return readFromStorage();
}

export function recordVisit(
  record: Omit<RecentRecord, "visitedAt"> & { visitedAt?: number },
): void {
  const visitedAt = record.visitedAt ?? Date.now();
  const next: RecentRecord = { ...record, visitedAt };
  const existing = readFromStorage().filter(
    (r) => !(r.kind === next.kind && r.id === next.id),
  );
  existing.unshift(next);
  writeToStorage(existing.slice(0, MAX_RECENT_RECORDS));
}

export function clearRecentRecords(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(STORAGE_EVENT));
  } catch {
    // ignore
  }
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(STORAGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(STORAGE_EVENT, listener);
  };
}

function getSnapshot(): string {
  if (typeof window === "undefined") return "[]";
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function getServerSnapshot(): string {
  return "[]";
}

export function useRecentRecords(): RecentRecord[] {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [records, setRecords] = useState<RecentRecord[]>(() => readFromStorage());
  useEffect(() => {
    setRecords(readFromStorage());
  }, [snapshot]);
  return records;
}

/**
 * Records a visit to a detail record once it's available. Pass `null`
 * while the record is still loading; the visit is logged exactly once
 * per (kind, id) pair for the lifetime of the calling component.
 */
export function useRecordVisit(
  record: Omit<RecentRecord, "visitedAt"> | null,
): void {
  useEffect(() => {
    if (!record) return;
    recordVisit(record);
    // Re-record when the identity of the record changes. Title/subtitle
    // updates within the same record id are intentionally ignored to
    // avoid noisy writes while the user edits a detail page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.kind, record?.id]);
}
