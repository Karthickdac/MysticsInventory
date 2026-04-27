import app from "./app";
import { logger } from "./lib/logger";
import { startShiprocketSyncScheduler } from "./lib/shiprocketSync";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Arm the daily Shiprocket tracking sweep. The scheduler is a
  // simple in-process timer; on multi-instance deployments only one
  // replica should run it (set SHIPROCKET_SYNC_DISABLED=1 on the
  // others). Set the same env var to skip it during local dev/tests.
  startShiprocketSyncScheduler();
});
