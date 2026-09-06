import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const barrier = process.env.MSB_RECOVERY_TEST_CLEANUP_BARRIER_DIRECTORY
writeFileSync(join(barrier, "cleanup-ready"), "ready\n", { mode: 0o600 })
const deadline = Date.now() + 10_000
while (!existsSync(join(barrier, "cleanup-release")) && Date.now() < deadline) await Bun.sleep(5)
writeFileSync(join(barrier, "cleanup-finished"), "finished\n", { mode: 0o600 })
