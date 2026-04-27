import { format as dateFnsFormat, parseISO } from "date-fns";

export function formatCurrency(amount: number, maxFractionDigits: number = 0): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: maxFractionDigits,
  }).format(amount);
}

export function formatDate(dateString: string | null | undefined, formatStr: string = 'd MMM yyyy'): string {
  if (!dateString) return "";
  try {
    return dateFnsFormat(parseISO(dateString), formatStr);
  } catch (e) {
    return dateString;
  }
}
