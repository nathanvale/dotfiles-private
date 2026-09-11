# Simple profile

Use this layout for a small CLI whose behaviour stays local to one entry point.

```
package.json
tsconfig.json
src/cli.ts
tests/cli.test.ts
```

`src/cli.ts` owns metadata, strict argument parsing with `node:util` `parseArgs` (`strict: true`, `allowPositionals: true`), the operation, the human and machine renderers, the envelope builder, and `main`. This profile uses no runtime dependency and no LogTape.

Illustrative skeleton only; this is not a schema:

```ts
import { parseArgs } from "node:util";

const meta = {
  name: "sample",
  contractVersion: "1.0.0",
  generationConventionVersion: "1.0.0",
} as const;

const exitFor = (failureClass: string | null) =>
  ({ null: 0, usage: 2, domain: 3, schema: 4, internal: 1, unavailable: 75 })[
    failureClass ?? "null"
  ];

const envelope = (partial: Record<string, unknown>) => {
  const value = { envelopeVersion: 1, ...meta, outcome: "success", failureClass: null, ...partial };
  return { value, exitCode: exitFor(value.failureClass as string | null) };
};

const fail = (causeCode: string, message: string, repairAction: string) =>
  envelope({ outcome: "refused", failureClass: "domain", causeCode, message, repairAction });

const main = () => {
  const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" }, discover: { type: "boolean" }, json: { type: "boolean" } }, strict: true, allowPositionals: true });
  if (values.help) { process.stdout.write("Usage: sample [--discover] [--json]\n"); return 0; }
  const output = values.discover ? envelope({ result: meta }) : envelope({ result: null });
  process.stdout.write(values.json ? JSON.stringify(output.value) + "\n" : "ok\n");
  return output.exitCode;
};

const code = main();
process.exit(code);
```

## Tests

Write process-level tests with `Bun.spawn` against `bun run src/cli.ts`. Assert exit code, stdout, and stderr for each scenario, with expected values written as literals rather than computed values.

## Full example

The runnable conformant example is `../../../packages/cli-design-check/fixtures/conformant/src/cli.ts`.
