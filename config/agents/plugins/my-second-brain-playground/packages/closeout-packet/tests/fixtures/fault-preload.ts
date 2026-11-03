// Test-owned Bun preload. public-bin.ts loads it through BUN_OPTIONS so a fault reaches the shipped bin and runtime.
import { type Fault, installFault } from "./faults.ts";

const spec = process.env.CLOSEOUT_PACKET_TEST_FAULT;
if (spec !== undefined) await installFault(JSON.parse(spec) as Fault);
