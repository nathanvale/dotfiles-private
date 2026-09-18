import { expect, test } from "bun:test"
import { REASON_CAUSES, WARNING_CODES } from "../../src/model.ts"

// The refusal vocabulary is closed and every reason maps to one Contract Core 2.0 cause under a known prefix
// (CONTRACT.md 3.3). The expected reason list is a literal so an added or renamed reason is a reviewed edit.

const expectedReasons = [
	"config-home-invalid", "config-absent", "config-unparseable", "config-off-schema", "vault-not-found", "not-canonical-main",
	"path-form-invalid", "path-escapes-vault", "path-symlink-component", "state-home-missing", "git-failed", "candidate-not-found",
	"manifest-invalid", "receipt-invalid", "guard-incompatible", "candidate-changed-after-commit", "candidate-history-invalid",
	"check-changed-candidate", "path-set-mismatch", "path-set-changed-by-checker", "check-failed", "format-failed", "integration-busy",
	"canonical-not-ready", "main-diverged", "semantic-overlap", "rebase-failed", "rebased-path-set-mismatch", "rebased-check-failed",
	"integration-unproved", "completion-record-failed", "unexpected",
]

test("the reason vocabulary is exactly the expected closed list", () => {
	expect(Object.keys(REASON_CAUSES).sort()).toEqual([...expectedReasons].sort())
})

test("every cause carries a 2.0 class prefix", () => {
	for (const cause of Object.values(REASON_CAUSES)) expect(cause).toMatch(/^(SUCCESS|USAGE|SCHEMA|DOMAIN|TRANSIENT|INTERNAL)_[A-Z_]+$/)
	expect(REASON_CAUSES["integration-busy"]).toBe("TRANSIENT_INTEGRATION_BUSY")
	expect(REASON_CAUSES["guard-incompatible"]).toBe("DOMAIN_GUARD_INCOMPATIBLE")
})

test("the warning vocabulary is the seven codes of GUARD-INTERACTION.md section 5", () => {
	expect([...WARNING_CODES]).toEqual(["GUARD_MISSING", "GUARD_STALE", "GUARD_PROBE_ALLOWED", "GUARD_SELFTEST_ERROR", "BRANCH_SPRAWL_PRESENT", "FOREIGN_WORKTREE_PRESENT", "HOOKS_PATH_OVERRIDE"])
})
