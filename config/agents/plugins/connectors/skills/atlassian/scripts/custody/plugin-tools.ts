// Ordinary-run lookup of the executables `connectors setup` installed into
// plugin-owned state. The setup owners select them by the qualified binary
// digests in this plugin's requirements.json, reached through their own
// module location, never an environment value or the working directory. A
// missing, unselected, or changed copy is null, and the caller refuses with
// the setup repair so a wrong copy is never run.
export { installedOp as selectedOp } from "../../../../bin/setup/op.ts";
export const UV_SETUP_REPAIR = "the plugin-owned uv is not set up; run connectors setup";
