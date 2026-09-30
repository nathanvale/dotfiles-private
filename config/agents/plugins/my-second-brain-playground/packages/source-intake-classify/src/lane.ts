// The classifier lane's fixed shape: which roots it must not read, which Codex it runs, its permission profile, and
// the one set of configuration arguments shared by the pre-flight probes and the model run. Nothing here is taken
// from the lane input; HOME, XDG_STATE_HOME, CODEX_HOME, TMPDIR and PATH are trusted configuration from the granted
// foreground caller, as in source-intake-dispatch.
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { CLASSIFICATION_SCHEMA } from "./classification.ts"
import instructions from "./lane-instructions.md" with { type: "text" }

export const LANE_MODEL = "gpt-6-luna"
export const LANE_REASONING_EFFORT = "medium"
export const PROFILE_NAME = "msb_source_intake_classify"
const PRIVATE_ROOT = "my-second-brain-playground"
const LANE_HOME = ["source-intake-classify", "codex-home"] as const
const SCHEMA_FILE = "classification.schema.json"
const LANE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
// Features that reach outside the lane's sandboxed tools or load instructions beyond the dedicated set.
const DISABLED_FEATURES = [
	"apps",
	"browser_use",
	"browser_use_external",
	"computer_use",
	"goals",
	"hooks",
	"image_generation",
	"in_app_browser",
	"memories",
	"multi_agent",
	"multi_agent_v2",
	"plugins",
	"realtime_conversation",
	"recommended_plugins",
	"remote_plugin",
	"shell_snapshot",
	"skill_mcp_dependency_install",
	"tool_suggest",
]

export interface Lane {
	/** The physical Codex binary, run by absolute path. */
	codex: string
	/** The Codex release directory the lane may read, so Codex can start its own sandboxed helpers. */
	codexPackage: string
	/** Every spelling of both private receipt roots the profile denies, sorted and unique. */
	deniedRoots: string[]
	/** The configured private root, where the lane's Codex home and pre-flight sentinel live. */
	privateRoot: string
	/** Codex home for the lane: no config.toml, no AGENTS.md, only a link to the caller's auth.json. */
	laneHome: string
	authTarget: string
	profile: string
	configArgs: string[]
	env: Record<string, string>
}

/** The account record's home, read from the operating system, never from HOME. Null when it cannot be read. */
function accountHome(): string | null {
	const macos = process.platform === "darwin"
	const cmd = macos ? ["/usr/bin/id", "-P"] : ["getent", "passwd", String(process.getuid?.() ?? "")]
	try {
		const result = Bun.spawnSync({ cmd, env: { PATH: LANE_PATH }, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000 })
		if (result.exitCode !== 0) return null
		const fields = result.stdout.toString().trim().split(":")
		const home = fields[macos ? 8 : 5]
		return home !== undefined && isAbsolute(home) ? home : null
	} catch {
		return null
	}
}

/** The spelled path, plus its physical path when it exists and differs, so Seatbelt matches either spelling. */
function spellings(path: string): string[] {
	try {
		const physical = realpathSync(path)
		return physical === path ? [path] : [path, physical]
	} catch {
		return [path]
	}
}

function contains(ancestor: string, path: string): boolean {
	return path === ancestor || path.startsWith(`${ancestor}/`)
}

/**
 * Resolves codex from the caller's PATH to its physical binary and release directory. The release directory gets a
 * read grant, so it must not hold the home directory, and must neither hold nor sit inside a receipt root.
 */
function resolveCodex(path: string | undefined, deniedRoots: readonly string[], home: string): { codex: string; codexPackage: string } | null {
	const found = Bun.which("codex", { PATH: path ?? "" })
	if (found === null) return null
	const codex = realpathSync(found)
	const codexPackage = dirname(dirname(codex))
	if (codexPackage === "/" || contains(codexPackage, home)) return null
	return deniedRoots.some((root) => contains(codexPackage, root) || contains(root, codexPackage)) ? null : { codex, codexPackage }
}

/**
 * The configured state root, by the source-intake-dispatch rule: XDG_STATE_HOME, else HOME plus /.local/state, else
 * the account record's home plus /.local/state. It must exist and be its own physical path.
 */
function configuredStateHome(account: string): string | null {
	const configured = process.env.XDG_STATE_HOME || `${process.env.HOME || account}/.local/state`
	return isAbsolute(configured) && existsSync(configured) && spellings(configured).length === 1 ? configured : null
}

function ensurePrivateDirectory(path: string): boolean {
	mkdirSync(path, { recursive: true, mode: 0o700 })
	const stat = lstatSync(path)
	return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path
}

/** The lane's Codex home holds a link to the caller's auth.json, created once; anything else there is refused. */
function ensureAuthLink(laneHome: string, authTarget: string): boolean {
	const link = join(laneHome, "auth.json")
	if (!existsSync(authTarget)) return false
	try {
		const stat = lstatSync(link)
		return stat.isSymbolicLink() && readlinkSync(link) === authTarget
	} catch {
		symlinkSync(authTarget, link)
		return true
	}
}

function toml(value: string): string {
	return JSON.stringify(value)
}

/** The lane permission profile as one TOML inline table. Deny wins over read on the same path; the more specific entry wins otherwise. */
function laneProfile(deniedRoots: readonly string[], codexPackage: string): string {
	const entries: [string, string][] = [
		[":root", "deny"],
		[":minimal", "read"],
		[":tmpdir", "deny"],
		[":slash_tmp", "deny"],
		[codexPackage, "read"],
		...deniedRoots.map((root): [string, string] => [root, "deny"]),
	]
	const filesystem = entries.map(([path, access]) => `${toml(path)}=${toml(access)}`).join(", ")
	return `{filesystem={${filesystem}, ":workspace_roots"={"."="read"}}, network={enabled=false}}`
}

/** One configuration for the pre-flight sandbox, the pre-flight prompt render and the model run. */
export function laneConfigArgs(profile: string): string[] {
	const settings = [
		`model=${toml(LANE_MODEL)}`,
		`model_reasoning_effort=${toml(LANE_REASONING_EFFORT)}`,
		`approval_policy="never"`,
		`web_search="disabled"`,
		`shell_environment_policy.inherit="none"`,
		"allow_login_shell=false",
		"skills.include_instructions=false",
		"include_apps_instructions=false",
		// Codex 0.159.2 keeps multi-agent v2 collaboration on with both multi_agent features disabled; this turns it off.
		"agents.enabled=false",
		`developer_instructions=${toml(instructions)}`,
		`permissions.${PROFILE_NAME}=${profile}`,
		`default_permissions=${toml(PROFILE_NAME)}`,
	]
	return [...settings.flatMap((setting) => ["-c", setting]), ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature])]
}

/** SHA-256 over every lane configuration argument (profile, settings, instructions and disabled features), in order. */
export function configHash(configArgs: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(configArgs)).digest("hex")
}

export function schemaPathFor(lane: Lane): string {
	return join(lane.laneHome, SCHEMA_FILE)
}

/** Resolves and prepares the lane. Null means the fixed lane refusal; nothing here reads a receipt. */
export function prepareLane(): Lane | null {
	try {
		return resolveLane()
	} catch {
		return null
	}
}

function resolveLane(): Lane | null {
	const account = accountHome()
	const stateHome = account === null ? null : configuredStateHome(account)
	if (account === null || stateHome === null) return null
	const privateRoot = join(stateHome, PRIVATE_ROOT)
	const deniedRoots = [...new Set([...spellings(privateRoot), ...spellings(join(account, ".local", "state", PRIVATE_ROOT))])].sort()
	const home = process.env.HOME || account
	const resolved = resolveCodex(process.env.PATH, deniedRoots, home)
	if (resolved === null) return null
	const laneHome = join(privateRoot, ...LANE_HOME)
	const codexHome = process.env.CODEX_HOME || join(home, ".codex")
	const authTarget = join(codexHome, "auth.json")
	if (!isAbsolute(authTarget) || !ensurePrivateDirectory(laneHome) || !ensureAuthLink(laneHome, authTarget)) return null
	const profile = laneProfile(deniedRoots, resolved.codexPackage)
	writeFileSync(join(laneHome, SCHEMA_FILE), JSON.stringify(CLASSIFICATION_SCHEMA), { mode: 0o600 })
	const env: Record<string, string> = { HOME: home, CODEX_HOME: laneHome, PATH: LANE_PATH, SHELL: "/bin/zsh", LANG: "C" }
	const temporary = process.env.TMPDIR
	if (temporary !== undefined && isAbsolute(temporary)) env.TMPDIR = temporary
	return { ...resolved, deniedRoots, privateRoot, laneHome, authTarget, profile, configArgs: laneConfigArgs(profile), env }
}

/** A fresh, empty 0700 working directory for one run. The profile grants it read only. */
export function createWorkspace(): string {
	const workspace = realpathSync(mkdtempSync(join(tmpdir(), "source-intake-classify-")))
	chmodSync(workspace, 0o700)
	return workspace
}
