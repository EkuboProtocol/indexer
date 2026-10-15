import { readFileSync, writeFileSync } from "node:fs";

const SUPPRESSIONS_FILE = "lint-suppressions.json";

type Suppressions = Record<string, Record<string, { count: number }>>;

interface Diagnostic {
  message: string;
  code?: string;
  filename: string;
  help?: string;
  labels?: { span: { line: number; column: number } }[];
}

const args = process.argv.slice(2);
const prune = args.includes("--prune");
const suppressRules = args
  .filter((arg) => arg.startsWith("--suppress-rule="))
  .map((arg) => arg.slice("--suppress-rule=".length));
const oxlintArgs = args.filter(
  (arg) => arg !== "--prune" && !arg.startsWith("--suppress-rule="),
);

const result = Bun.spawnSync(
  ["oxlint", "--format=json", "--max-warnings=0", ...oxlintArgs],
  {
    stdout: "pipe",
    stderr: "inherit",
  },
);
let diagnostics: Diagnostic[];
try {
  diagnostics = (
    JSON.parse(result.stdout.toString()) as { diagnostics: Diagnostic[] }
  ).diagnostics;
} catch {
  console.error(result.stdout.toString());
  console.error(
    `oxlint did not produce a report (exit code ${result.exitCode})`,
  );
  process.exit(result.exitCode || 1);
}

const ruleOf = (diagnostic: Diagnostic) => diagnostic.code ?? "oxlint";

const found = new Map<string, Map<string, Diagnostic[]>>();
for (const diagnostic of diagnostics) {
  const byRule = found.get(diagnostic.filename) ?? new Map();
  found.set(diagnostic.filename, byRule);
  const list = byRule.get(ruleOf(diagnostic)) ?? [];
  byRule.set(ruleOf(diagnostic), list);
  list.push(diagnostic);
}

const suppressions = JSON.parse(
  readFileSync(SUPPRESSIONS_FILE, "utf8"),
) as Suppressions;

function write(next: Suppressions) {
  const sorted: Suppressions = {};
  for (const file of Object.keys(next).sort()) {
    const rules = Object.keys(next[file]!).sort();
    if (rules.length === 0) continue;
    sorted[file] = Object.fromEntries(
      rules.map((rule) => [rule, next[file]![rule]!]),
    );
  }
  writeFileSync(SUPPRESSIONS_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

if (suppressRules.length > 0) {
  for (const [file, byRule] of found) {
    for (const rule of suppressRules) {
      const count = byRule.get(rule)?.length ?? 0;
      if (count === 0) continue;
      suppressions[file] ??= {};
      suppressions[file][rule] = { count };
    }
  }
  write(suppressions);
}

if (prune) {
  for (const [file, rules] of Object.entries(suppressions)) {
    for (const [rule, { count }] of Object.entries(rules)) {
      const actual = found.get(file)?.get(rule)?.length ?? 0;
      if (actual === 0) delete rules[rule];
      else rules[rule] = { count: Math.min(count, actual) };
    }
  }
  write(suppressions);
}

const annotate = process.env.GITHUB_ACTIONS === "true";
const escape = (text: string) =>
  text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

let failures = 0;
for (const [file, byRule] of found) {
  for (const [rule, list] of byRule) {
    const allowed = suppressions[file]?.[rule]?.count ?? 0;
    if (list.length <= allowed) continue;
    for (const diagnostic of list) {
      failures++;
      const span = diagnostic.labels?.[0]?.span;
      const position = span ? `:${span.line}:${span.column}` : "";
      console.log(`${file}${position}  ${rule}  ${diagnostic.message}`);
      if (diagnostic.help) console.log(`  help: ${diagnostic.help}`);
      if (annotate) {
        const location = span ? `,line=${span.line},col=${span.column}` : "";
        console.log(
          `::error file=${file}${location},title=${escape(rule)}::${escape(diagnostic.message)}`,
        );
      }
    }
    if (allowed > 0) {
      console.log(
        `  ${file} is recorded with ${allowed} ${rule} violation(s) and now has ${list.length}; fix the new one, do not raise the count.`,
      );
    }
  }
}

let unused = 0;
for (const [file, rules] of Object.entries(suppressions)) {
  for (const [rule, { count }] of Object.entries(rules)) {
    const actual = found.get(file)?.get(rule)?.length ?? 0;
    if (actual >= count) continue;
    unused++;
    console.log(
      `${file}  ${rule}  recorded ${count}, found ${actual}: run \`bun run lint:prune\` and commit ${SUPPRESSIONS_FILE}`,
    );
  }
}

const recorded = diagnostics.length - failures;
if (failures > 0 || unused > 0) {
  console.log(
    `\n${failures} violation(s) and ${unused} outdated suppression(s); ${recorded} known violation(s) are recorded in ${SUPPRESSIONS_FILE}.`,
  );
  process.exit(1);
}
console.log(
  `No new lint violations; ${recorded} known violation(s) are recorded in ${SUPPRESSIONS_FILE}.`,
);
