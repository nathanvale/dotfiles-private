# Jira mapping

The recipient can trace each claimed requirement to the state actually supplied.

## Sub-features

- `jira-covered`: an admitted requirement maps to a supplied family or example.
- `jira-held`: missing criteria and reference-only states remain visible.
- `jira-packaged`: a source-only example names its actual module or story.

## How to get to it (user POV)

Read `Explore by Jira requirement`, then follow a family or select an example in
the announcement. In a source-only package, open the named module or story.

## Driving it with the delivery record and native browser

Preconditions: read the admitted requirement locators, current package manifest
and actual example inventory. Retain their recorded source versions.

- **Map.** For each requirement claimed by the draft, identify the supplied state
  and its coverage limit from the delivery evidence. Use the original Jira URL.
- **Follow.** Drive published destinations through [preview links](preview-links.md).
  Read packaged examples from the qualified package instead of fabricating URLs.
- **Compare.** Confirm the example actually shows the capability named beside it.
  Keep a parent issue distinct from a story, design reference, reported result
  and observed test. Preserve historical status dates where relevant.
- **Return.** Account for every claimed row and example. Label engineering,
  held and uncovered behaviour beside its mapping. Carry unresolved decisions
  forward without presenting them as implemented rules or executed QA.

## Gotchas

A valid Jira link proves neither coverage nor current deployment. A single
admitted state cannot stand for a whole story or journey. Keep unsupported rows
explicit rather than increasing the apparent scope to fill a template.
