import { afterAll, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { cleanupFixtures, fixture, git, write, type Fixture } from "../helpers/harness.ts"
import { apply, candidate, data, must, preview, run } from "../helpers/steward.ts"

afterAll(cleanupFixtures)

function remoteFixture(): { f: Fixture; remote: string; peer: string } {
	const f = fixture()
	const remote = join(f.root, "remote.git")
	const peer = join(f.root, "peer")
	git(f.root, "clone", remote, peer)
	git(peer, "config", "user.name", "Peer")
	git(peer, "config", "user.email", "peer@example.invalid")
	return { f, remote, peer }
}

function advance(peer: string, path = "README.md"): string {
	write(peer, path, "# Remote update\n")
	git(peer, "add", "--", path)
	git(peer, "commit", "-m", "docs: remote update")
	git(peer, "push", "origin", "HEAD:refs/heads/main")
	return git(peer, "rev-parse", "HEAD")
}

test("begin fast-forwards from the real remote before choosing its candidate base", () => {
	const { f, peer } = remoteFixture()
	const head = advance(peer)
	const started = must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"]), "SUCCESS_COMPLETED")
	expect((data(started).candidate as { baseCommit: string }).baseCommit).toBe(head)
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(head)
	expect(readFileSync(join(f.vault, "README.md"), "utf8")).toBe("# Remote update\n")
})

test("another real fetch cannot replace the bound remote evidence through FETCH_HEAD", () => {
	const { f, peer, remote } = remoteFixture()
	git(peer, "push", "origin", `${f.initialHead}:refs/heads/unrelated`)
	const head = advance(peer)
	const wrappers = join(f.root, "concurrent-fetch")
	const realGit = Bun.which("git")!
	const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`
	write(wrappers, "git", `#!/bin/sh\n${quotedGit} "$@"\nstatus=$?\nif [ "$status" -eq 0 ] && [ "$2" = fetch ]; then ${quotedGit} fetch --no-tags '${remote}' refs/heads/unrelated >/dev/null 2>&1; fi\nexit "$status"\n`)
	chmodSync(join(wrappers, "git"), 0o755)
	const started = must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"], { PATH: `${wrappers}:${process.env.PATH}` }), "SUCCESS_COMPLETED")
	expect((data(started).candidate as { baseCommit: string }).baseCommit).toBe(head)
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(head)
	expect(git(f.vault, "rev-parse", "FETCH_HEAD")).toBe(f.initialHead)
})

test("apply publishes its integrated commit and a repeated apply never integrates twice", () => {
	const { f, remote } = remoteFixture()
	git(f.vault, "tag", "-a", "private-tag", "-m", "Not part of publication")
	git(f.vault, "config", "push.followTags", "true")
	const worktree = candidate(f)
	const id = preview(f, worktree)
	must(apply(f, worktree, id), "SUCCESS_COMPLETED")
	const head = git(f.vault, "rev-parse", "HEAD")
	expect(git(remote, "rev-parse", "refs/heads/main")).toBe(head)
	expect(git(remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main")
	must(apply(f, worktree, id), "SUCCESS_UNCHANGED")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
})

test.each(["tracked", "untracked"])("dirty %s canonical work survives a refused begin", (kind) => {
	const { f, peer, remote } = remoteFixture()
	const remoteHead = advance(peer)
	const path = kind === "tracked" ? "README.md" : "unfinished.md"
	write(f.vault, path, "Owned unfinished work.\n")
	must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"]), "DOMAIN_CANONICAL_NOT_READY")
	expect(readFileSync(join(f.vault, path), "utf8")).toBe("Owned unfinished work.\n")
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(f.initialHead)
	expect(git(remote, "rev-parse", "main")).toBe(remoteHead)
})

test("divergent main refuses before creating a candidate or rewriting either history", () => {
	const { f, peer, remote } = remoteFixture()
	const remoteHead = advance(peer)
	write(f.vault, "local.md", "Local.\n")
	git(f.vault, "add", "--", "local.md")
	git(f.vault, "commit", "-m", "docs: local update")
	const localHead = git(f.vault, "rev-parse", "HEAD")
	must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"]), "DOMAIN_MAIN_DIVERGED")
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(localHead)
	expect(git(remote, "rev-parse", "main")).toBe(remoteHead)
	expect(git(f.vault, "worktree", "list", "--porcelain").match(/worktree /g)).toHaveLength(1)
})

test("offline fetch refuses begin before candidate creation", () => {
	const { f, remote } = remoteFixture()
	rmSync(remote, { recursive: true })
	must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"]), "INTERNAL_GIT_FAILED_UNCHANGED")
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(f.initialHead)
	expect(git(f.vault, "worktree", "list", "--porcelain").match(/worktree /g)).toHaveLength(1)
})

test("an unconfigured upstream refuses begin without creating a candidate", () => {
	const { f } = remoteFixture()
	git(f.vault, "remote", "remove", "origin")
	const refused = must(run(f, ["begin", "--vault", f.vault, "--path", "projects/demo/GOAL.md"]), "INTERNAL_GIT_FAILED_UNCHANGED")
	expect(refused.message).toContain("Configure main to track")
	expect(git(f.vault, "worktree", "list", "--porcelain").match(/worktree /g)).toHaveLength(1)
})

test.each(["nathanvale", "server"])("portable configured vault expands against %s's HOME through the public CLI", (user) => {
	const { f } = remoteFixture()
	const home = join(f.root, user)
	mkdirSync(join(home, "code"), { recursive: true })
	symlinkSync(f.vault, join(home, "code", "my-second-brain-playground"))
	write(join(f.root, "config"), "my-second-brain-playground/vault.json", JSON.stringify({ schemaVersion: 1, vault: "~/code/my-second-brain-playground" }))
	const started = must(run(f, ["begin", "--path", "projects/demo/GOAL.md"], { HOME: home }), "SUCCESS_COMPLETED")
	expect(data(started).vault).toBe(f.vault)
	expect((data(started).candidate as { baseCommit: string }).baseCommit).toBe(f.initialHead)
})

test("a remote advance refuses apply before preview consumption; re-preview admits disjoint work", () => {
	const { f, peer, remote } = remoteFixture()
	const worktree = candidate(f)
	const id = preview(f, worktree)
	const remoteHead = advance(peer)
	must(apply(f, worktree, id), "DOMAIN_PREVIEW_STALE")
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(f.initialHead)
	expect(existsSync(worktree)).toBe(true)
	must(apply(f, worktree, preview(f, worktree)), "SUCCESS_COMPLETED")
	expect(git(remote, "merge-base", remoteHead, "main")).toBe(remoteHead)
	expect(readFileSync(join(f.vault, "projects/demo/GOAL.md"), "utf8")).toContain("Completed.")
})

test("a rejected push preserves its local receipt; repeated apply publishes without a second commit", () => {
	const { f, remote } = remoteFixture()
	const hook = join(remote, "hooks", "pre-receive")
	write(remote, "hooks/pre-receive", "#!/bin/sh\nexit 1\n")
	chmodSync(hook, 0o755)
	const worktree = candidate(f)
	const id = preview(f, worktree)
	const rejected = must(apply(f, worktree, id), "INTERNAL_GIT_FAILED_PARTIAL")
	expect(rejected.result.transactionState).toBe("partially-completed")
	expect(git(remote, "rev-parse", "main")).toBe(f.initialHead)
	const head = git(f.vault, "rev-parse", "HEAD")
	must(run(f, ["inspect", "--worktree", worktree]), "SUCCESS_UNCHANGED")
	const receiptPreview = must(run(f, ["finish", "--preview", "--worktree", worktree, "--message", "docs: change"]), "SUCCESS_UNCHANGED")
	expect(data(receiptPreview).publication).toEqual({ status: "not-checked" })
	const refusedAgain = must(apply(f, worktree, id), "INTERNAL_GIT_FAILED_UNCHANGED")
	expect(refusedAgain.result.effects.completed).toEqual([])
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(head)
	rmSync(hook)
	must(apply(f, worktree, id), "SUCCESS_COMPLETED")
	expect(git(remote, "rev-parse", "main")).toBe(head)
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
})

test.each(["tracked", "untracked", "other-branch"])("receipt publication preserves %s canonical work and refuses both apply and recover", (kind) => {
	const { f, remote } = remoteFixture()
	const hook = join(remote, "hooks", "pre-receive")
	write(remote, "hooks/pre-receive", "#!/bin/sh\nexit 1\n")
	chmodSync(hook, 0o755)
	const worktree = candidate(f)
	const id = preview(f, worktree)
	must(apply(f, worktree, id), "INTERNAL_GIT_FAILED_PARTIAL")
	rmSync(hook)
	const head = git(f.vault, "rev-parse", "HEAD")
	const path = kind === "tracked" ? "README.md" : "unfinished.md"
	if (kind === "other-branch") git(f.vault, "-c", "core.hooksPath=/nonexistent", "switch", "-c", "owned-work")
	else write(f.vault, path, "Owned unfinished work.\n")
	for (const args of [["finish", "--apply", "--preview-id", id, "--worktree", worktree], ["recover", "--worktree", worktree]]) {
		const refused = must(run(f, args), "INTERNAL_GIT_FAILED_UNCHANGED")
		expect(refused.result.effects.completed).toEqual([])
		expect(refused.message).toContain("Synchronization preserves tracked and untracked work")
	}
	expect(git(remote, "rev-parse", "main")).toBe(f.initialHead)
	expect(git(f.vault, "rev-parse", "HEAD")).toBe(head)
	if (kind === "other-branch") expect(git(f.vault, "branch", "--show-current")).toBe("owned-work")
	else expect(readFileSync(join(f.vault, path), "utf8")).toBe("Owned unfinished work.\n")
})

test("an accepted push with a lost acknowledgement reports the observed remote effect and never integrates twice", () => {
	const { f, remote } = remoteFixture()
	const worktree = candidate(f)
	const id = preview(f, worktree)
	const wrappers = join(f.root, "transport")
	const realGit = Bun.which("git")!
	// This real transport wrapper loses only the acknowledgement, after bare Git has accepted the exact push.
	const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`
	write(wrappers, "git", `#!/bin/sh\n${quotedGit} "$@"\nstatus=$?\nif [ "$status" -eq 0 ] && [ "$2" = push ]; then exit 1; fi\nexit "$status"\n`)
	chmodSync(join(wrappers, "git"), 0o755)
	const accepted = must(run(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree], { PATH: `${wrappers}:${process.env.PATH}` }), "SUCCESS_COMPLETED")
	expect(accepted.result.effects.completed).toContain("remote.push")
	const head = git(f.vault, "rev-parse", "HEAD")
	expect(git(remote, "rev-parse", "main")).toBe(head)
	must(apply(f, worktree, id), "SUCCESS_UNCHANGED")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
})

test("a lost push read-back reports uncertainty and repeated apply uses remote evidence", () => {
	const { f, remote } = remoteFixture()
	const worktree = candidate(f)
	const id = preview(f, worktree)
	const wrappers = join(f.root, "readback-offline")
	const marker = join(wrappers, "pushed")
	const realGit = Bun.which("git")!
	const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`
	write(wrappers, "git", `#!/bin/sh\nif [ -f '${marker}' ] && [ "$2" = ls-remote ]; then exit 128; fi\n${quotedGit} "$@"\nstatus=$?\nif [ "$status" -eq 0 ] && [ "$2" = push ]; then touch '${marker}'; fi\nexit "$status"\n`)
	chmodSync(join(wrappers, "git"), 0o755)
	const unknown = must(run(f, ["finish", "--apply", "--preview-id", id, "--worktree", worktree], { PATH: `${wrappers}:${process.env.PATH}` }), "INTERNAL_GIT_FAILED_UNKNOWN")
	expect(unknown.result.effects.uncertain).toEqual(["remote.push"])
	const head = git(f.vault, "rev-parse", "HEAD")
	expect(git(remote, "rev-parse", "main")).toBe(head)
	must(apply(f, worktree, id), "SUCCESS_UNCHANGED")
	expect(git(f.vault, "rev-list", "--count", `${f.initialHead}..main`)).toBe("1")
})
