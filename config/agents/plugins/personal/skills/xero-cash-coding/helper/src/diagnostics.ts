import { configure, getLogger } from "@logtape/logtape";
import { redactByField } from "@logtape/redaction";

let configured = false;

export function attemptEmergencyDiagnostic(): void {
  try {
    getLogger("example").fatal("Unexpected process termination");
  } catch {
    // Crash handling is best-effort and must not replace the process outcome.
  }
}

export async function recordDiagnostic(commandIdentity: string): Promise<void> {
  if (!configured) {
    const sink = redactByField(
      () => undefined,
      ["token", "password", "secret"],
    );
    await configure({
      loggers: [
        {
          category: "logtape",
          lowestLevel: "warning",
          parentSinks: "override",
          sinks: ["memory"],
        },
        {
          category: "example",
          lowestLevel: "info",
          parentSinks: "override",
          sinks: ["memory"],
        },
      ],
      reset: true,
      sinks: { memory: sink },
    });
    configured = true;
  }
  getLogger("example").info("Command {commandIdentity}", { commandIdentity });
}
