import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { loadConfig } from "../config";
import { main } from "./worker";

// The cascading .env files load synchronously, before anything reads a
// setting: Effect's default ConfigProvider reads `process.env`.
loadConfig();

// `runMain` installs the SIGINT/SIGTERM handlers and interrupts the program,
// which closes the scope opened here -- so shutdown is the scope's finalizers
// rather than a handler that has to remember what to clean up.
BunRuntime.runMain(Effect.scoped(main));
