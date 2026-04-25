---
domain_format_version: 1
domain_key: integrate-elluciancloud-com-au
vendor: Ellucian
service: Ethos Integration / Experience Proxy
url: https://integrate.elluciancloud.com.au
auth_required: true
auth_type: password_totp
service_key: ellucian-ethos
profile: ellucian
notes: >
  Ethos Integration console for managing API keys, proxy applications,
  and integration configurations. Used to provision ethosApiKey values
  that are pasted into tenant Card Management.
---

# integrate.elluciancloud.com.au

Ellucian Ethos Integration / Experience Proxy console.

## Target Flows

### bootstrap-observe

- **purpose:** Observe the console layout, navigation, and API key management UI
- **action_class:** read-only
- **cold_start_reset:** Navigate to https://integrate.elluciancloud.com.au and authenticate via Ellucian Okta SSO
- **maturity:** bootstrap

### create-api-key

- **purpose:** Create a new Ethos API key scoped to the test environment
- **action_class:** write-capable
- **cold_start_reset:** Navigate to https://integrate.elluciancloud.com.au, authenticate via Ellucian Okta SSO, locate the API key creation interface
- **maturity:** candidate

## Domain Gotchas

## Earned Artifacts

## Iteration Log
