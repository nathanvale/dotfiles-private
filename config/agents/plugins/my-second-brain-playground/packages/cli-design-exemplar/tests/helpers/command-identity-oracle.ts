// Independent test oracle: the accepted C0 2.0 command vocabulary, including the existing dispatch identity.
// Deliberately authored separately from production declarations. Do not derive or deduplicate into production.
export const EXPECTED_COMMAND_IDENTITIES = ["repair-lab.dispatch", "repair-lab.help", "repair-lab.discovery", "repair-lab.status", "repair-lab.inspect", "repair-lab.inspect-diagnostics", "repair-lab.preview", "repair-lab.apply", "repair-lab.repair", "repair-lab.repair-retry", "repair-lab.recover"] as const
