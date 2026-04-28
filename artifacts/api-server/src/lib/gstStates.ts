// GST state codes used by the NIC EWB / e-invoice systems. These
// numeric codes (1-37) are part of every GSTIN — the first two
// digits — and are also required as standalone fields in EWB
// payloads.
//
// Source: GST Council notification 18/2017-CT.

export const GST_STATES: ReadonlyArray<{ code: number; name: string }> = [
  { code: 1, name: "Jammu and Kashmir" },
  { code: 2, name: "Himachal Pradesh" },
  { code: 3, name: "Punjab" },
  { code: 4, name: "Chandigarh" },
  { code: 5, name: "Uttarakhand" },
  { code: 6, name: "Haryana" },
  { code: 7, name: "Delhi" },
  { code: 8, name: "Rajasthan" },
  { code: 9, name: "Uttar Pradesh" },
  { code: 10, name: "Bihar" },
  { code: 11, name: "Sikkim" },
  { code: 12, name: "Arunachal Pradesh" },
  { code: 13, name: "Nagaland" },
  { code: 14, name: "Manipur" },
  { code: 15, name: "Mizoram" },
  { code: 16, name: "Tripura" },
  { code: 17, name: "Meghalaya" },
  { code: 18, name: "Assam" },
  { code: 19, name: "West Bengal" },
  { code: 20, name: "Jharkhand" },
  { code: 21, name: "Odisha" },
  { code: 22, name: "Chhattisgarh" },
  { code: 23, name: "Madhya Pradesh" },
  { code: 24, name: "Gujarat" },
  { code: 25, name: "Daman and Diu" },
  { code: 26, name: "Dadra and Nagar Haveli" },
  { code: 27, name: "Maharashtra" },
  { code: 28, name: "Andhra Pradesh (Old)" },
  { code: 29, name: "Karnataka" },
  { code: 30, name: "Goa" },
  { code: 31, name: "Lakshadweep" },
  { code: 32, name: "Kerala" },
  { code: 33, name: "Tamil Nadu" },
  { code: 34, name: "Puducherry" },
  { code: 35, name: "Andaman and Nicobar Islands" },
  { code: 36, name: "Telangana" },
  { code: 37, name: "Andhra Pradesh" },
];

const NAME_TO_CODE: Map<string, number> = new Map(
  GST_STATES.map((s) => [s.name.toLowerCase(), s.code]),
);

/**
 * Resolve a state name (case-insensitive, trimmed) to its GST code.
 * Returns null when the name is missing or unrecognised.
 */
export function gstStateCodeFromName(
  name: string | null | undefined,
): number | null {
  if (!name) return null;
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return null;
  return NAME_TO_CODE.get(trimmed) ?? null;
}

/**
 * Extract the state code from the first two digits of a GSTIN. Falls
 * back to null on a malformed GSTIN.
 */
export function gstStateCodeFromGstin(
  gstin: string | null | undefined,
): number | null {
  if (!gstin || gstin.length < 2) return null;
  const n = Number(gstin.slice(0, 2));
  return Number.isFinite(n) && n >= 1 && n <= 37 ? n : null;
}
