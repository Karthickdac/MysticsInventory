import { defineConfig } from "drizzle-kit";
import fs from "fs";
import path from "path";

// Load DATABASE_URL from the monorepo root .env if it isn't already
// in the environment. This makes `pnpm --filter @workspace/db run push`
// work out-of-the-box on self-hosted deploys without needing to first
// `source .env`. Replit sets DATABASE_URL via the platform, so this
// path is only taken on VPS / local machines.
if (!process.env.DATABASE_URL) {
  const rootEnv = path.resolve(__dirname, "..", "..", ".env");
  if (fs.existsSync(rootEnv)) {
    for (const rawLine of fs.readFileSync(rootEnv, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
