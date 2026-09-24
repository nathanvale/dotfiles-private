import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBundle, runBundle } from "./harness.ts";

// Independent literal of the accepted lock recovery instruction.
const LOCK_RECOVERY = "Independently verify the .selection.lock owner identity and that its process has ended, then immediately recheck the lock before removing it and retrying the same command";

test("ordinary schema first use behind an unsafe selection lock gives lock recovery, not revision inspection", async () => {
	const bundle = createBundle();
	const home = path.join(bundle.root, "home");
	const state = path.join(bundle.root, "state");
	const mcporter = path.join(state, "connectors", "mcporter");
	mkdirSync(home);
	mkdirSync(mcporter, { recursive: true, mode: 0o700 });
	bundle.addSkill("keyless-fixture-skill");
	const external = path.join(bundle.root, "unrelated-lock-target");
	writeFileSync(external, "do not change\n");
	symlinkSync(external, path.join(mcporter, ".selection.lock"));
	try {
		const run = await runBundle(bundle, ["schema", "keyless-fixture-skill"], { home, extraEnv: { XDG_STATE_HOME: state }, timeoutMs: 15_000 });
		expect(run.code).toBe(1);
		expect(run.stderr).toBe("");
		const result = JSON.parse(run.stdout).result;
		expect(result.commandIdentity).toBe("connectors.schema");
		expect(result.causeCode).toBe("INTERNAL_MCPORTER_SELECTION_UNKNOWN");
		expect(result.transactionState).toBe("unknown");
		expect(result.repairAction).toBe(LOCK_RECOVERY);
		expect(readFileSync(external, "utf8")).toBe("do not change\n");
		expect(lstatSync(path.join(mcporter, ".selection.lock")).isSymbolicLink()).toBe(true);
	} finally {
		bundle.dispose();
	}
}, 20_000);
