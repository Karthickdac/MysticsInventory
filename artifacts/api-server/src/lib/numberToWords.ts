const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

function under1000(n: number): string {
  if (n < 20) return ONES[n] ?? "";
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r === 0 ? TENS[t]! : `${TENS[t]} ${ONES[r]}`;
  }
  const h = Math.floor(n / 100);
  const r = n % 100;
  return r === 0
    ? `${ONES[h]} Hundred`
    : `${ONES[h]} Hundred ${under1000(r)}`;
}

function intToWordsIndian(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  if (crore > 0) parts.push(`${under1000(crore)} Crore`);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  if (lakh > 0) parts.push(`${under1000(lakh)} Lakh`);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  if (thousand > 0) parts.push(`${under1000(thousand)} Thousand`);
  n %= 1000;
  if (n > 0) parts.push(under1000(n));
  return parts.join(" ");
}

export function rupeesInWords(amount: number): string {
  if (!Number.isFinite(amount)) return "";
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  let out = `${intToWordsIndian(rupees)} Rupees`;
  if (paise > 0) out += ` and ${intToWordsIndian(paise)} Paise`;
  out += " Only";
  if (negative) out = `Minus ${out}`;
  return out;
}
