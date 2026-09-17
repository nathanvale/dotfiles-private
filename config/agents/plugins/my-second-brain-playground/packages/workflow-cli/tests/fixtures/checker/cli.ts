// Shim-lane process entry: the production main() over fixtureContext(). The shim-lane tests and the cli-design
// checker spawn this file with MSB_WORKFLOW_BD_EXECUTABLE naming the fixture bd; src/cli.ts stays the production
// and bundle entry with the accepted pin, which refuses the fixture bd.

import { main } from "../../../src/cli.ts"
import { fixtureContext } from "./fixture-context.ts"

main(fixtureContext())
