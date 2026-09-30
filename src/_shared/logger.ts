import { createLogger, format, transports } from "winston";
import { redactSecrets } from "./redactSecrets";

// winston's serialized output lives under this symbol (triple-beam's MESSAGE).
const MESSAGE = Symbol.for("message");

/**
 * Redacts the line exactly as it will be written, after serialization, so a key
 * is caught wherever it sits: the message, an error's stack or a `cause`, or
 * any metadata field.
 */
const redact = format((info) => {
  const line = (info as Record<symbol, unknown>)[MESSAGE];
  if (typeof line === "string") {
    (info as Record<symbol, unknown>)[MESSAGE] = redactSecrets(line);
  }
  return info;
});

export const loggerFormat = format.combine(
  format.errors({ stack: true }),
  format.splat(),
  format.json(),
  redact(),
);

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: loggerFormat,
  defaultMeta: { service: "ekubo-indexer" },
  transports: [new transports.Console()],
});

process.on("uncaughtException", function (err) {
  logger.error("Uncaught exception", err);
  process.exit(1); // Exit the process with failure
});

process.on("unhandledRejection", function (err) {
  logger.error("Unhandled promise rejection", err);
  process.exit(1); // Exit the process with failure
});
