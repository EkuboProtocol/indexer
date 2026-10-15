import { installLogRedaction } from "./redactLogs";

installLogRedaction();

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection", error);
  process.exit(1);
});
