// An unconditional alternate source entry: `bun run src/main.ts` calls main() with no import.meta.main guard. It is not
// the launcher or bundle entry; bin/msb-workflow execs runtime/msb-workflow.js, which is bundled from src/cli.ts, the
// same file the frozen smoke command runs, so the guard there stays a live runtime expression. The CLI Module owns the
// process wiring so that this entry and src/cli.ts behave identically.

import { main } from "./cli.ts"

main()
