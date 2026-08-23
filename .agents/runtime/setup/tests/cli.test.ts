import { describe, expect, test } from "bun:test";

import { main } from "../src/cli.ts";
import type {
  VaultGitHostEnrollment,
  VaultGitHostEnrollmentResult,
} from "../src/vault-git-host-enrollment.ts";

const input = JSON.stringify({
  ssh_identity_file_path: "/private/fixture/id",
  ssh_public_key_path: "/private/fixture/id.pub",
  ssh_known_hosts_path: "/private/fixture/known_hosts",
});

function capture() {
  const stdout = { text: "", write(value: string) { this.text += value; } };
  const stderr = { text: "", write(value: string) { this.text += value; } };
  return { stdout, stderr };
}

function owner(overrides: Partial<VaultGitHostEnrollment> = {}): VaultGitHostEnrollment {
  const notEnrolled: VaultGitHostEnrollmentResult = {
    state: "not_enrolled",
    station: "vault_git.host_enrollment_inputs_required",
    nextAction: {
      kind: "needs_input",
      actionId: "provide_host_enrollment_inputs",
      inputContractId: "setup.vault-git.host-enrollment",
      fields: [
        { id: "ssh_identity_file_path", inputChannel: "private_stdin" },
        { id: "ssh_public_key_path", inputChannel: "private_stdin" },
        { id: "ssh_known_hosts_path", inputChannel: "private_stdin" },
      ],
    },
    installedRuntime: null,
    selectedRuntime: null,
    priorRuntime: null,
  };
  return {
    inspect: async () => notEnrolled,
    preview: async () => notEnrolled as never,
    apply: async () => notEnrolled as never,
    rollback: async () => { throw new Error("not used"); },
    ...overrides,
  };
}

function runtime(vaultGitHostEnrollment: VaultGitHostEnrollment, readPrivateStdin?: () => Promise<string>) {
  return { homeDir: "/home/fixture", env: {}, vaultGitHostEnrollment, readPrivateStdin };
}

describe("Setup CLI Vault Git facade", () => {
  test("no args and plain sync project read-only status", async () => {
    const io = capture();
    expect(await main([], { ...io, runtime: runtime(owner()) })).toBe(0);
    expect(io.stdout.text).toContain("sync.vault_git_inputs_required");
    expect(io.stderr.text).toBe("");
  });

  test("commands emits the private-stdin contract as one JSON document", async () => {
    const io = capture();
    expect(await main(["commands", "--json"], { ...io, runtime: runtime(owner()) })).toBe(0);
    expect(io.stderr.text).toBe("");
    expect(JSON.parse(io.stdout.text)).toMatchObject({
      status: "ok",
      data: {
        commands: {
          sync: {
            mutation: "write",
            input_contracts: [{
              id: "setup.vault-git.host-enrollment",
              action_argv: ["sync", "--domain", "vault-git"],
              fields: [
                { id: "ssh_identity_file_path", input_channel: "private_stdin" },
                { id: "ssh_public_key_path", input_channel: "private_stdin" },
                { id: "ssh_known_hosts_path", input_channel: "private_stdin" },
              ],
            }],
          },
        },
      },
    });
  });

  test("commands requires JSON, rollback rejects private input, and error channel follows JSON mode", async () => {
    const plain = capture();
    expect(await main(["commands"], { ...plain, runtime: runtime(owner()) })).toBe(2);
    expect(plain.stdout.text).toBe("");
    expect(plain.stderr.text).toContain("requires --json");
    const json = capture();
    expect(await main(["sync", "--domain", "vault-git", "--rollback", "--input-stdin", "setup.vault-git.host-enrollment", "--json"], { ...json, runtime: runtime(owner()) })).toBe(2);
    expect(json.stderr.text).toBe("");
    expect(JSON.parse(json.stdout.text).error.code).toBe("invalid_usage");
  });

  test("preview uses private stdin and keeps values out of the public result", async () => {
    const io = capture();
    let received = false;
    const result: VaultGitHostEnrollmentResult = {
      state: "needs_human",
      station: "vault_git.repository_ssh_prerequisite",
      nextAction: { kind: "needs_human", actionId: "provision_repository_ssh", owner: "repository_ssh_owner", condition: "dedicated_identity_ready" },
      missingPrerequisites: ["ssh_identity_file"],
      installedRuntime: null,
      selectedRuntime: null,
      priorRuntime: null,
    };
    const enrollment = owner({
      preview: async (values) => {
        received = values.sshIdentityFilePath === "/private/fixture/id";
        return result;
      },
    });
    expect(await main(["sync", "--domain", "vault-git", "--check", "--input-stdin", "setup.vault-git.host-enrollment", "--json"], {
      ...io,
      runtime: runtime(enrollment, async () => input),
    })).toBe(1);
    expect(received).toBe(true);
    expect(io.stdout.text).not.toContain("/private/fixture");
    expect(io.stderr.text).toBe("");
    expect(JSON.parse(io.stdout.text).data).toMatchObject({ station: "sync.vault_git_ssh_prerequisite", next_action: "provision_repository_ssh" });
  });

  test("missing and oversized private input have distinct usage failures", async () => {
    const missing = capture();
    expect(await main(["sync", "--domain", "vault-git", "--input-stdin", "setup.vault-git.host-enrollment"], {
      ...missing,
      runtime: runtime(owner()),
    })).toBe(2);
    expect(missing.stderr.text).toContain("unavailable");

    const oversized = capture();
    expect(await main(["sync", "--domain", "vault-git", "--input-stdin", "setup.vault-git.host-enrollment"], {
      ...oversized,
      runtime: runtime(owner(), async () => JSON.stringify({ ssh_identity_file_path: "x".repeat(17_000) })),
    })).toBe(2);
    expect(oversized.stderr.text).toContain("16,384-byte limit");
    expect(oversized.stderr.text).not.toContain("17_000");
  });

  test("rollback dispatches through the dedicated owner and preserves preview distinction", async () => {
    const io = capture();
    let check: boolean | undefined;
    const result: VaultGitHostEnrollmentResult = {
      state: "changes",
      station: "vault_git.rollback_ready",
      selectedRuntime: { digest: "a".repeat(64) },
      priorRuntime: { digest: "b".repeat(64) },
    };
    expect(await main(["sync", "--domain", "vault-git", "--rollback", "--check", "--json"], {
      ...io,
      runtime: runtime(owner({ rollback: async (value) => { check = value; return result; } })),
    })).toBe(1);
    expect(check).toBe(true);
    expect(JSON.parse(io.stdout.text).data).toMatchObject({ station: "sync.vault_git_rollback_ready" });
  });
});
