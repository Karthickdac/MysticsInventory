import { toNum, toStr } from "./numeric";

export interface ComputedLine {
  itemId: number;
  description: string | null;
  quantity: string;
  unitPrice: string;
  taxRate: string;
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

export function computeOrderTotals(
  rawLines: Array<{
    itemId: number;
    quantity: number | string;
    unitPrice: number | string;
    taxRate: number | string;
    description?: string | null;
  }>,
): ComputedTotals {
  let subtotal = 0;
  let taxTotal = 0;
  const lines: ComputedLine[] = rawLines.map((l) => {
    const qty = toNum(l.quantity);
    const price = toNum(l.unitPrice);
    const tax = toNum(l.taxRate);
    const lineSubtotal = qty * price;
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
