// Must stay the first import: see the module.
import "./redactedConsole";
import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { loadConfig } from "../config";
import { main } from "./worker";

// The cascading .env files load synchronously, before anything reads a
// setting: Effect's default ConfigProvider reads `process.env`.
loadConfig();

BunRuntime.runMain(Effect.scoped(main));
