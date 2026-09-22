import { expect, test } from "bun:test";
import { safeEnvironment } from "../bin/safe-environment.ts";

test("the shared Connector environment owner forwards only its literal safe key set", () => {
	const environment = safeEnvironment({
		HOME: "/safe/home",
		PATH: "/safe/bin",
		LANG: "en_AU.UTF-8",
		LC_ALL: "en_AU.UTF-8",
		TMPDIR: "/safe/tmp",
		XDG_STATE_HOME: "/safe/state",
		ATLASSIAN_API_KEY: "must-not-cross",
		OP_SERVICE_ACCOUNT_TOKEN: "must-not-cross",
		AMBIENT_SENTINEL: "must-not-cross",
	});
	expect(environment).toEqual({
		HOME: "/safe/home",
		PATH: "/safe/bin",
		LANG: "en_AU.UTF-8",
		LC_ALL: "en_AU.UTF-8",
		TMPDIR: "/safe/tmp",
		XDG_STATE_HOME: "/safe/state",
	});
});
