#!/usr/bin/env bun
// Claude Code WorktreeRemove hook entry. See worktree-hook.ts.

import { runWorktreeHook } from "./worktree-hook.ts";

process.exit(
	runWorktreeHook("remove", await Bun.stdin.text(), {
		stdout: (line) => process.stdout.write(`${line}\n`),
		stderr: (line) => process.stderr.write(`${line}\n`),
	}),
);
