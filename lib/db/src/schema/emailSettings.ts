import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

/**
 * Per-organization SMTP configuration for outbound mail (e.g. when an
 * org wants its invoice copies sent from its own branded address).
 *
 * System-level transactional emails (signup verification, password
 * reset) do NOT read this table — they always use the global
 * SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM env vars. That
 * separation matters because signup happens before the user belongs
 * to any org.
 *
 * `password` is stored encrypted-at-rest using APP_ENCRYPTION_KEY
 * (see artifacts/api-server/src/lib/crypto.ts).
 */
export const emailSettingsTable = pgTable("email_settings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .unique()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  // "ssl" => implicit TLS (port 465-style), "starttls" => upgrade
  // after EHLO (port 587-style), "none" => plain SMTP (dev only).
  secure: text("secure").notNull().default("starttls"),
  username: text("username").notNull(),
  passwordEncrypted: text("password_encrypted").notNull(),
  fromEmail: text("from_email").notNull(),
  fromName: text("from_name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type EmailSettings = typeof emailSettingsTable.$inferSelect;
