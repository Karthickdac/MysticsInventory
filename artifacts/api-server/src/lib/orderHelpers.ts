import { toNum, toStr } from "./numeric";

export interface ComputedLine {
  itemId: number;
  description: string | null;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  discountPercent: string;
  discountAmount: string;
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
}

export interface ComputedTotals {
  lines: ComputedLine[];
  subtotal: string;
  taxTotal: string;
  total: string;
}

/**
 * Resolve effective discount amount given operator inputs. Operator
 * may set EITHER a percent (0-100) OR a flat amount in rupees.
 * Percent wins if both are non-zero. Result is clamped to gross
 * (qty * unitPrice) so we never produce a negative line subtotal.
 */
function resolveDiscount(
  gross: number,
  pct: number,
  amt: number,
): { discountPercent: number; discountAmount: number } {
  let discountPercent = Number.isFinite(pct) && pct > 0 ? pct : 0;
  if (discountPercent > 100) discountPercent = 100;
  let discountAmount: number;
  if (discountPercent > 0) {
    discountAmount = Math.round(((gross * discountPercent) / 100) * 100) / 100;
  } else {
    discountAmount = Number.isFinite(amt) && amt > 0 ? amt : 0;
  }
  if (discountAmount > gross) discountAmount = gross;
  if (discountAmount < 0) discountAmount = 0;
  return { discountPercent, discountAmount };
}

export function computeOrderTotals(
  rawLines: Array<{
    itemId: number;
    quantity: number | string;
    unitPrice: number | string;
    taxRate: number | string;
    discountPercent?: number | string | null;
    discountAmount?: number | string | null;
    description?: string | null;
  }>,
): ComputedTotals {
  let subtotal = 0;
  let taxTotal = 0;
  const lines: ComputedLine[] = rawLines.map((l) => {
    const qty = toNum(l.quantity);
    const price = toNum(l.unitPrice);
    const tax = toNum(l.taxRate);
    const gross = qty * price;
    const { discountPercent, discountAmount } = resolveDiscount(
      gross,
      toNum(l.discountPercent ?? 0),
      toNum(l.discountAmount ?? 0),
    );
    const lineSubtotal = gross - discountAmount;
    const lineTax = (lineSubtotal * tax) / 100;
    const lineTotal = lineSubtotal + lineTax;
    subtotal += lineSubtotal;
    taxTotal += lineTax;
    return {
      itemId: l.itemId,
      description: l.description ?? null,
      quantity: toStr(qty),
      unitPrice: toStr(price),
      taxRate: toStr(tax),
      discountPercent: toStr(discountPercent),
      discountAmount: toStr(discountAmount),
      lineSubtotal: toStr(lineSubtotal),
      lineTax: toStr(lineTax),
      lineTotal: toStr(lineTotal),
    };
  });
  return {
    lines,
    subtotal: toStr(subtotal),
    taxTotal: toStr(taxTotal),
    total: toStr(subtotal + taxTotal),
  };
}

export function nextOrderNumber(prefix: string): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const rand = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");
  return `${prefix}-${yy}${mm}${dd}-${rand}`;
}
