// Test-owned Bun preload. public-bin.ts loads it through BUN_OPTIONS so faults reach the shipped bin and runtime.
import { type Fault, installFaults } from "./faults.ts";

const spec = process.env.CLOSEOUT_PACKET_TEST_FAULT;
if (spec !== undefined) await installFaults(JSON.parse(spec) as Fault[]);
