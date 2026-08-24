import { VAULT_GIT_HOST_ENROLLMENT_INPUT_FIELDS } from "./vault-git-host-enrollment.ts";

export const SETUP_INPUT_CONTRACT_ID = "setup.vault-git.host-enrollment" as const;

const setupInputFields = VAULT_GIT_HOST_ENROLLMENT_INPUT_FIELDS.map(
	({ id, inputChannel }) => ({ id, input_channel: inputChannel }),
);

export const setupCommandDiscovery = {
  commands: {
    sync: {
      script: "setup",
      mutation: "write",
      side_effects: ["read", "check", "write"],
      flags: {
        "--domain": { type: "enum", values: ["vault-git"] },
        "--check": { type: "boolean" },
        "--rollback": { type: "boolean" },
        "--input-stdin": { type: "enum", values: [SETUP_INPUT_CONTRACT_ID] },
        "--json": { type: "boolean" },
      },
      input_contracts: [
        {
		  id: SETUP_INPUT_CONTRACT_ID,
		  action_id: "provide_host_enrollment_inputs",
		  action_argv: ["sync", "--domain", "vault-git", "--check"],
          fields: setupInputFields,
        },
        {
          id: SETUP_INPUT_CONTRACT_ID,
          action_id: "apply_host_enrollment",
          action_argv: ["sync", "--domain", "vault-git"],
          fields: setupInputFields,
        },
      ],
    },
    commands: {
      script: "setup",
      mutation: "check",
      side_effects: ["read"],
      flags: { "--json": { type: "boolean" } },
    },
  },
} as const;

export type ParsedSetupInvocation = {
  readonly command: "sync" | "commands";
  readonly domain?: "vault-git";
  readonly check: boolean;
  readonly rollback: boolean;
  readonly inputStdin?: typeof SETUP_INPUT_CONTRACT_ID;
  readonly json: boolean;
  readonly noArgs: boolean;
};

export class SetupUsageError extends Error {}

/** Parse the one flat Setup facade grammar. */
export function parseSetupInvocation(argv: readonly string[]): ParsedSetupInvocation {
  const noArgs = argv.length === 0;
  const command = noArgs ? "sync" : argv[0];
  if (command !== "sync" && command !== "commands") {
    throw new SetupUsageError(`Unknown command: ${command ?? "(missing)"}`);
  }
  let domain: "vault-git" | undefined;
  let check = false;
  let rollback = false;
  let inputStdin: typeof SETUP_INPUT_CONTRACT_ID | undefined;
  let json = false;
  for (let index = noArgs ? 0 : 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") check = true;
    else if (token === "--rollback") rollback = true;
    else if (token === "--json") json = true;
    else if (token === "--domain") {
      if (argv[index + 1] !== "vault-git") throw new SetupUsageError("Expected --domain vault-git");
      domain = "vault-git";
      index += 1;
    } else if (token === "--input-stdin") {
      if (argv[index + 1] !== SETUP_INPUT_CONTRACT_ID) throw new SetupUsageError(`Expected --input-stdin ${SETUP_INPUT_CONTRACT_ID}`);
      inputStdin = SETUP_INPUT_CONTRACT_ID;
      index += 1;
    } else throw new SetupUsageError(`Unknown option: ${token}`);
  }
	if (command === "commands" && (domain || check || rollback || inputStdin || !json)) throw new SetupUsageError("commands requires --json");
	if (rollback && domain !== "vault-git") throw new SetupUsageError("--rollback requires --domain vault-git");
	if (inputStdin && domain !== "vault-git") throw new SetupUsageError("--input-stdin requires --domain vault-git");
	if (rollback && inputStdin) throw new SetupUsageError("--rollback cannot be combined with --input-stdin");
  return { command, domain, check, rollback, inputStdin, json, noArgs };
}
