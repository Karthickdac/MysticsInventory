import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { buildSessionMiddleware } from "./lib/sessions";

const app: Express = express();

// We always sit behind a TLS-terminating proxy in production (pm2
// behind nginx) and in the Replit preview proxy in dev. Trust the
// first hop so express-session honours `secure` cookies and req.ip
// reflects the real client.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(buildSessionMiddleware());
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// JSON error handler for the API.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode ?? 500;
  const message = (err as { message?: string })?.message ?? "Internal Server Error";
  if (status >= 500) {
    req.log?.error({ err }, "Unhandled error");
  }
  res.status(status).json({ error: message });
});

export default app;
