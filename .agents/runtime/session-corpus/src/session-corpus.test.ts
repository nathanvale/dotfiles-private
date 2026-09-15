import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import {
	createRepositoryMatcher,
	extractSessionFragmentsPage,
	extractSessionPage,
	listSessionFiles,
	parseNormalizedMessage,
	parseSessionMetadata,
	redactSessionText,
} from "./index.ts"

describe("shared session corpus", () => {
	test("parses native identifiers and helper ancestry without exposing source paths", () => {
		const metadata = parseSessionMetadata({
			type: "session_meta",
			payload: {
				id: "codex-one",
				cwd: "/private/repo",
				parent_thread_id: "parent-one",
				thread_source: "subagent",
			},
		}, "codex", "/private/session.jsonl")

		expect(metadata).toMatchObject({
			opaqueId: "codex:codex-one",
			parentSessionId: "parent-one",
			kind: "helper",
		})
		expect(JSON.stringify({ ...metadata, path: undefined })).not.toContain("session.jsonl")
	})

	test("preserves Claude metadata fields and Codex fallback classifications", () => {
		const claudeHelper = parseSessionMetadata({
			type: "user",
			sessionId: "claude-helper",
			cwd: "/private/repo",
			gitBranch: "feature/session",
			timestamp: "2026-09-12T00:00:00Z",
			parentSessionId: "claude-parent",
			isSidechain: true,
		}, "claude", "/private/claude-helper.jsonl")

		expect(claudeHelper).toEqual({
			source: "claude",
			opaqueId: "claude:claude-helper",
			sessionId: "claude-helper",
			path: "/private/claude-helper.jsonl",
			cwd: "/private/repo",
			branch: "feature/session",
			startedAt: "2026-09-12T00:00:00Z",
			parentSessionId: "claude-parent",
			kind: "helper",
		})
		expect(parseSessionMetadata({
			type: "assistant",
			sessionId: "claude-agent",
			cwd: "/private/repo",
			agentId: "agent-one",
		}, "claude", "/private/claude-agent.jsonl")?.kind).toBe("helper")
		expect(parseSessionMetadata({
			type: "assistant",
			sessionId: "claude-primary",
			cwd: "/private/repo",
		}, "claude", "/private/claude-primary.jsonl")?.kind).toBe("primary")
		expect(parseSessionMetadata({ type: "user", cwd: "/private/repo" }, "claude", "/private/missing-id.jsonl"))
			.toBeUndefined()
		expect(parseSessionMetadata({ type: "user", sessionId: "missing-cwd" }, "claude", "/private/missing-cwd.jsonl"))
			.toBeUndefined()
		expect(parseSessionMetadata({ type: "session_meta" }, "codex", "/private/missing-payload.jsonl"))
			.toBeUndefined()
		expect(parseSessionMetadata({ type: "session_meta", payload: { cwd: "/private/repo" } }, "codex", "/private/missing-codex-id.jsonl"))
			.toBeUndefined()
		expect(parseSessionMetadata({
			type: "session_meta",
			payload: { id: "codex-primary" },
		}, "codex", "/private/codex-primary.jsonl")?.kind).toBe("primary")
	})

	test("normalizes prose and redacts common credential shapes", () => {
		const message = parseNormalizedMessage({
			type: "response_item",
			payload: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Use ghp_abcdefghijklmnopqrstuvwxyz123456." }],
			},
		}, "codex")
		const redacted = redactSessionText(message?.text ?? "")

		expect(redacted.text).toBe("Use [REDACTED].")
		expect(redacted.redactions).toBe(1)
	})

	test("normalizes Claude messages and skips invalid conversation records", () => {
		expect(parseNormalizedMessage({
			type: "assistant",
			timestamp: "2026-09-12T00:00:00Z",
			message: { role: "assistant", content: "  Claude reply  " },
		}, "claude")).toEqual({
			role: "assistant",
			timestamp: "2026-09-12T00:00:00Z",
			text: "Claude reply",
		})
		expect(parseNormalizedMessage({
			type: "system",
			message: { role: "assistant", content: "ignored" },
		}, "claude")).toBeUndefined()
		expect(parseNormalizedMessage({
			type: "user",
			message: { role: "system", content: "ignored" },
		}, "claude")).toBeUndefined()
		expect(parseNormalizedMessage({
			type: "user",
			message: { role: "user", content: " \n\t" },
		}, "claude")).toBeUndefined()
	})

	test("rejects pagination that cannot make progress", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		try {
			const path = resolve(root, "session.jsonl")
			await Bun.write(path, `${JSON.stringify({
				type: "response_item",
				payload: { type: "message", role: "user", content: "hello" },
			})}\n`)
			const metadata = {
				source: "codex" as const,
				opaqueId: "codex:one",
				sessionId: "one",
				path,
				kind: "primary" as const,
			}

			await expect(extractSessionPage(metadata, {
				offset: 0,
				limit: 0,
				maxMessageChars: 2000,
			})).rejects.toThrow("limit must be a positive integer")
			await expect(extractSessionPage(metadata, {
				offset: -1,
				limit: 1,
				maxMessageChars: 2000,
			})).rejects.toThrow("offset must be a non-negative integer")
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("redacts private filesystem paths from extracted evidence", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		try {
			const path = resolve(root, "session.jsonl")
			await Bun.write(path, `${JSON.stringify({
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: "Read /Users/alice/private.txt, /home/bob/key and C:\\Users\\carol\\secret.txt",
				},
			})}\n`)
			const result = await extractSessionPage({
				source: "codex",
				opaqueId: "codex:one",
				sessionId: "one",
				path,
				kind: "primary",
			}, { offset: 0, limit: 1, maxMessageChars: 2000 })

			expect(result.messages[0]?.text).toBe("Read [REDACTED], [REDACTED] and [REDACTED]")
			expect(result.redactions).toBe(3)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("redacts common package, GitLab, header, cookie, and assignment credentials", () => {
		const value = [
			"npm_abcdefghijklmnopqrstuvwxyz123456",
			"github_pat_abcdefghijklmnopqrstuvwxyz123456",
			"glpat-abcdefghijklmnopqrstuvwxyz123456",
			"Authorization: Basic abcdefghijklmnop",
			"Cookie: session=abcdefghijklmnop",
			"password=abcdefghijklmnop",
			'"client_secret": "qrstuvwxyz123456"',
		].join("\n")

		const redacted = redactSessionText(value)

		expect(redacted.text).not.toContain("abcdefghijklmnop")
		expect(redacted.text).not.toContain("qrstuvwxyz123456")
		expect(redacted.redactions).toBe(7)
	})

	test("fails extraction when a selected fragment contains malformed JSONL", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		try {
			const path = resolve(root, "session.jsonl")
			await Bun.write(path, "{not-json}\n")
			await expect(extractSessionFragmentsPage([{
				source: "codex",
				opaqueId: "codex:one",
				sessionId: "one",
				path,
				kind: "primary",
			}], { offset: 0, limit: 1, maxMessageChars: 2000 })).rejects.toThrow(
				"Malformed JSONL record",
			)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("paginates one logical session across all fragments", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		try {
			const active = resolve(root, "active.jsonl")
			const archive = resolve(root, "archive.jsonl")
			const line = (text: string) => `${JSON.stringify({
				type: "response_item",
				payload: { type: "message", role: "user", content: text },
			})}\n`
			await Bun.write(archive, line("first"))
			await Bun.write(active, line("second"))
			const base = {
				source: "codex" as const,
				opaqueId: "codex:one",
				sessionId: "one",
				kind: "primary" as const,
			}

			const result = await extractSessionFragmentsPage([
				{ ...base, path: active, startedAt: "2026-08-02T00:00:00Z" },
				{ ...base, path: archive, startedAt: "2026-08-01T00:00:00Z" },
			], { offset: 1, limit: 1, maxMessageChars: 2000 })

			expect(result).toMatchObject({ totalMessages: 2, nextOffset: null })
			expect(result.messages).toEqual([expect.objectContaining({ index: 1, text: "second" })])
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("sorts malformed fragment timestamps after valid timestamps", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		try {
			const malformed = resolve(root, "a-malformed.jsonl")
			const valid = resolve(root, "z-valid.jsonl")
			const line = (text: string) => `${JSON.stringify({
				type: "response_item",
				payload: { type: "message", role: "user", content: text },
			})}\n`
			await Bun.write(malformed, line("malformed timestamp"))
			await Bun.write(valid, line("valid timestamp"))
			const base = {
				source: "codex" as const,
				opaqueId: "codex:one",
				sessionId: "one",
				kind: "primary" as const,
			}

			const result = await extractSessionFragmentsPage([
				{ ...base, path: malformed, startedAt: "not-a-timestamp" },
				{ ...base, path: valid, startedAt: "2026-08-01T00:00:00Z" },
			], { offset: 0, limit: 2, maxMessageChars: 2000 })

			expect(result.messages.map((message) => message.text)).toEqual([
				"valid timestamp",
				"malformed timestamp",
			])
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("lets matching Git common-directory evidence override stale recorded remotes", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		const repo = resolve(root, "repo")
		const worktree = resolve(root, "worktree")
		try {
			await mkdir(repo)
			expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0)
			expect(Bun.spawnSync(["git", "-C", repo, "config", "user.email", "test@example.com"]).exitCode).toBe(0)
			expect(Bun.spawnSync(["git", "-C", repo, "config", "user.name", "Test"]).exitCode).toBe(0)
			await Bun.write(resolve(repo, "README.md"), "test\n")
			expect(Bun.spawnSync(["git", "-C", repo, "add", "README.md"]).exitCode).toBe(0)
			expect(Bun.spawnSync(["git", "-C", repo, "commit", "-qm", "test"]).exitCode).toBe(0)
			expect(Bun.spawnSync(["git", "-C", repo, "worktree", "add", "-q", worktree]).exitCode).toBe(0)
			const matcher = createRepositoryMatcher(repo)

			expect(matcher.match({
				source: "codex",
				opaqueId: "codex:one",
				sessionId: "one",
				path: "/private/session.jsonl",
				cwd: worktree,
				repositoryUrl: "https://github.com/example/stale.git",
				kind: "primary",
			})).toBe("git_common_dir")
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("does not collapse nested repository namespaces", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		const repo = resolve(root, "repo")
		try {
			await mkdir(repo)
			expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0)
			expect(Bun.spawnSync([
				"git", "-C", repo, "remote", "add", "origin", "https://gitlab.example.com/group/alpha/project.git",
			]).exitCode).toBe(0)
			const matcher = createRepositoryMatcher(repo)

			expect(matcher.matches({
				source: "codex",
				opaqueId: "codex:one",
				sessionId: "one",
				path: "/private/session.jsonl",
				repositoryUrl: "https://gitlab.example.com/other/alpha/project.git",
				kind: "primary",
			})).toBe(false)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("canonicalizes SCP remotes and rejects unusable repository identities", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		const repo = resolve(root, "repo")
		try {
			await mkdir(repo)
			expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0)
			expect(Bun.spawnSync([
				"git", "-C", repo, "remote", "add", "origin", "git@github.com:example/project.git",
			]).exitCode).toBe(0)
			const matcher = createRepositoryMatcher(repo)
			const metadata = {
				source: "codex" as const,
				opaqueId: "codex:one",
				sessionId: "one",
				path: "/private/session.jsonl",
				kind: "primary" as const,
			}

			expect(matcher.assess({
				...metadata,
				repositoryUrl: "git@github.com:example/project.git",
			})).toEqual({ status: "matched", kind: "repository_url" })
			expect(matcher.assess({
				...metadata,
				repositoryUrl: "git@github.com:example",
			})).toEqual({ status: "unresolved" })
			expect(matcher.assess({
				...metadata,
				repositoryUrl: "https://[invalid",
			})).toEqual({ status: "unresolved" })
			expect(matcher.assess({
				...metadata,
				repositoryUrl: "ftp://github.com/example/project.git",
			})).toEqual({ status: "unresolved" })
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("prefers direct paths and matches recorded remotes without a working directory", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		const repo = resolve(root, "repo")
		try {
			await mkdir(repo)
			expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0)
			expect(Bun.spawnSync([
				"git", "-C", repo, "remote", "add", "origin", "https://github.com/example/project.git",
			]).exitCode).toBe(0)
			const matcher = createRepositoryMatcher(repo)
			const metadata = {
				source: "claude" as const,
				opaqueId: "claude:one",
				sessionId: "one",
				path: "/private/session.jsonl",
				kind: "primary" as const,
			}

			expect(matcher.assess({
				...metadata,
				cwd: matcher.root,
				repositoryUrl: "https://github.com/other/project.git",
			})).toEqual({ status: "matched", kind: "path" })
			expect(matcher.assess({
				...metadata,
				repositoryUrl: "https://github.com/example/project.git",
			})).toEqual({ status: "matched", kind: "repository_url" })
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("matches a cache-miss candidate repository through its remote identity", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		const repo = resolve(root, "repo")
		const candidate = resolve(root, "candidate")
		const mismatchCandidate = resolve(root, "mismatch-candidate")
		const remoteMismatchCandidate = resolve(root, "remote-mismatch-candidate")
		try {
			await Promise.all([mkdir(repo), mkdir(candidate), mkdir(mismatchCandidate), mkdir(remoteMismatchCandidate)])
			expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0)
			expect(Bun.spawnSync(["git", "init", "--bare", "-q", candidate]).exitCode).toBe(0)
			expect(Bun.spawnSync(["git", "init", "-q", mismatchCandidate]).exitCode).toBe(0)
			expect(Bun.spawnSync(["git", "init", "--bare", "-q", remoteMismatchCandidate]).exitCode).toBe(0)
			for (const path of [repo, candidate, mismatchCandidate]) {
				expect(Bun.spawnSync([
					"git", "-C", path, "remote", "add", "origin", "https://github.com/example/project.git",
				]).exitCode).toBe(0)
			}
			expect(Bun.spawnSync([
				"git", "-C", remoteMismatchCandidate, "remote", "add", "origin", "https://github.com/other/project.git",
			]).exitCode).toBe(0)
			const matcher = createRepositoryMatcher(repo)

			expect(matcher.assess({
				source: "codex",
				opaqueId: "codex:one",
				sessionId: "one",
				path: "/private/session.jsonl",
				cwd: candidate,
				kind: "primary",
			})).toEqual({ status: "matched", kind: "repository_url" })
			expect(matcher.assess({
				source: "codex",
				opaqueId: "codex:two",
				sessionId: "two",
				path: "/private/session-two.jsonl",
				cwd: mismatchCandidate,
				kind: "primary",
			})).toEqual({ status: "mismatch" })
			expect(matcher.assess({
				source: "codex",
				opaqueId: "codex:three",
				sessionId: "three",
				path: "/private/session-three.jsonl",
				cwd: remoteMismatchCandidate,
				kind: "primary",
			})).toEqual({ status: "mismatch" })
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("preserves unresolved ownership for a removed worktree without repository evidence", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		const repo = resolve(root, "repo")
		try {
			await mkdir(repo)
			expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0)
			const matcher = createRepositoryMatcher(repo)

			expect(matcher.assess({
				source: "claude",
				opaqueId: "claude:one",
				sessionId: "one",
				path: "/private/session.jsonl",
				cwd: resolve(root, "removed", "repo"),
				kind: "primary",
			})).toEqual({ status: "unresolved" })
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("reports every configured root and preserves missing-source evidence", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		try {
			const claude = resolve(root, "claude")
			const codex = resolve(root, "codex")
			const archive = resolve(root, "missing-archive")
			await Promise.all([mkdir(claude), mkdir(codex)])
			await Bun.write(resolve(claude, "one.jsonl"), "{}\n")

			const result = await listSessionFiles({ claude, codexActive: codex, codexArchived: archive })

			expect(result.files).toHaveLength(1)
			expect(result.states).toEqual([
				{ source: "claude", location: "active", state: "available", files: 1, unreadable_directories: 0 },
				{ source: "codex", location: "active", state: "available", files: 0, unreadable_directories: 0 },
				{ source: "codex", location: "archive", state: "missing", files: 0, unreadable_directories: 0 },
			])
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("rethrows unexpected filesystem errors from a scan root", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		const scanRoot = resolve(root, "scan-root")
		try {
			await Bun.write(scanRoot, "regular file")

			await expect(listSessionFiles({
				claude: scanRoot,
				codexActive: resolve(root, "codex"),
				codexArchived: resolve(root, "archive"),
			})).rejects.toThrow("ENOTDIR")
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	test("counts unreadable traversal without exposing directory paths", async () => {
		const root = await mkdtemp(resolve(tmpdir(), "session-corpus-test-"))
		const claude = resolve(root, "claude")
		const blocked = resolve(claude, "blocked")
		const codex = resolve(root, "codex")
		const archive = resolve(root, "archive")
		try {
			await Promise.all([mkdir(claude), mkdir(codex), mkdir(archive)])
			await mkdir(blocked)
			await chmod(blocked, 0)

			const result = await listSessionFiles({ claude, codexActive: codex, codexArchived: archive })

			expect(result.states[0]).toMatchObject({ unreadable_directories: 1 })
			expect(JSON.stringify(result.states)).not.toContain(blocked)
		} finally {
			await chmod(blocked, 0o700).catch(() => {})
			await rm(root, { recursive: true, force: true })
		}
	})
})
