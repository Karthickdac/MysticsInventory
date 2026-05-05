import bcrypt from "bcryptjs";

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Minimum password policy — kept loose so existing users can pick
 * passwords they'll remember, but firm enough to refuse trivially
 * weak choices. Returns null if OK, or a human-readable error.
 */
export function validatePasswordStrength(plain: string): string | null {
  if (typeof plain !== "string") return "Password must be a string";
  if (plain.length < 8) return "Password must be at least 8 characters";
  if (plain.length > 200) return "Password must be at most 200 characters";
  return null;
}
