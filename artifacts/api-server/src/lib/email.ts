import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "./logger";

export class EmailNotConfiguredError extends Error {
  status = 503;
  constructor() {
    super(
      "Email is not configured on this server. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM, then try again.",
    );
    this.name = "EmailNotConfiguredError";
  }
}

let cached: Transporter | null = null;

function readConfig() {
  const host = process.env.SMTP_HOST?.trim();
  const portRaw = process.env.SMTP_PORT?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM?.trim();
  if (!host || !portRaw || !user || !pass || !from) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host, port, user, pass, from, secure: port === 465 };
}

function getTransport(): Transporter {
  if (cached) return cached;
  const cfg = readConfig();
  if (!cfg) throw new EmailNotConfiguredError();
  cached = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  return cached;
}

export function isEmailConfigured(): boolean {
  return readConfig() !== null;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType?: string;
  }>;
  replyTo?: string;
}

export async function sendEmail(
  input: SendEmailInput,
): Promise<{ messageId: string }> {
  const cfg = readConfig();
  if (!cfg) throw new EmailNotConfiguredError();
  const transport = getTransport();
  try {
    const info = await transport.sendMail({
      from: cfg.from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo,
      attachments: input.attachments,
    });
    return { messageId: info.messageId ?? "" };
  } catch (err) {
    logger.error({ err }, "sendEmail failed");
    throw err;
  }
}
