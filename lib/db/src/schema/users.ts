import { boolean, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    // Legacy Clerk user id. Nullable now that the app uses local
    // email + password auth — kept around so existing rows that were
    // created via Clerk continue to round-trip cleanly. New signups
    // leave this column null.
    clerkUserId: text("clerk_user_id"),
    email: text("email").notNull(),
    name: text("name"),
    // bcrypt hash of the user's password. Null only for legacy
    // Clerk-only rows that have not been given a password yet.
    // The admin set-password script populates this column.
    passwordHash: text("password_hash"),
    // Set when the user clicks the verification link sent on
    // signup. Until this is set, /auth/login refuses the credentials
    // with "please verify your email first".
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    // One-shot tokens used by the email verification flow.
    verifyToken: text("verify_token"),
    verifyTokenExpiresAt: timestamp("verify_token_expires_at", {
      withTimezone: true,
    }),
    // One-shot tokens used by the forgot-password flow.
    resetToken: text("reset_token"),
    resetTokenExpiresAt: timestamp("reset_token_expires_at", {
      withTimezone: true,
    }),
    // Platform-wide super admin. Bootstrapped from the
    // SUPER_ADMIN_EMAILS env var on every login (case-insensitive
    // comma-separated list of emails). Super admins can switch into
    // any organization via the X-Organization-Id header even when
    // they are not a member of that org.
    isSuperAdmin: boolean("is_super_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    clerkIdx: uniqueIndex("users_clerk_user_id_idx").on(t.clerkUserId),
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
    verifyTokenIdx: uniqueIndex("users_verify_token_idx").on(t.verifyToken),
    resetTokenIdx: uniqueIndex("users_reset_token_idx").on(t.resetToken),
  }),
);

export type User = typeof usersTable.$inferSelect;
