// The Atlassian Provider process: every refusal from an Atlassian Provider or
// its custody module carries the atlassian-provider:error: prefix.
import { type ProviderProcess, providerProcess } from "../../../bin/provider-process.ts";

export { type ProviderProcess, singleLine } from "../../../bin/provider-process.ts";

export const atlassianProcess: ProviderProcess = providerProcess("atlassian-provider");
