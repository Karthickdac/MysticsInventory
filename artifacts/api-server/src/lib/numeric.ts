export function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function toStr(v: number | string): string {
  return typeof v === "number" ? v.toFixed(2) : v;
}
