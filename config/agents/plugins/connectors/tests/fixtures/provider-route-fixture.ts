#!/usr/bin/env bun
// Test-owned entry: the same launcher main, bound to the fixture skills root.
// Production callers use bin/provider-route.ts, whose root is the plugin's own
// skills directory and cannot be overridden by argv or the environment.
import path from "node:path";
import { main } from "../../bin/provider-route.ts";

main(process.argv.slice(2), path.resolve(import.meta.dir));
