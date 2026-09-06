# Upstream provenance

- Source: Puppeteer page-interactions and browser-management guides, commit
  `c324e1bb5b1a33e793324669d402fd2e32e28707`, retrieved 2026-09-03.
  https://github.com/puppeteer/puppeteer/blob/c324e1bb5b1a33e793324669d402fd2e32e28707/docs/guides/page-interactions.md
  https://github.com/puppeteer/puppeteer/blob/c324e1bb5b1a33e793324669d402fd2e32e28707/docs/guides/browser-management.md
- Compatibility input: installed metadata observed version `24.32.0`.
- License: Apache-2.0. No upstream text or examples copied.
- Local synthesis maps the lane helper's fixed actions and schema-2 page
  evaluation; see the [script contract](../../../references/scripts.md). It
  omits host library scripts, browser creation or connection, tabs, navigation, storage,
  screenshots, PDF, network APIs, and locator guarantees absent from the helper.
