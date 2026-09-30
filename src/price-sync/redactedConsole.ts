import { installLogRedaction } from "./redactLogs";

// Imported first by the entry point, so the console is redacting before any
// other module is evaluated, and a throw during import or outside the Effect
// runtime is printed through it instead of by Bun directly.
installLogRedaction();

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
  process.exit(1);
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection", error);
  process.exit(1);
});
