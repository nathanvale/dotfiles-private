# Worked example: a missing compiler config

Sanitized from the GR11 Storybook repair. Project identities, service links,
credential locations and raw logs remain with the project's evidence owner.
The sequence below is historical evidence, not a fresh skill execution.

## Failure and reconstruction

A local Storybook build passed, but the deployed container build failed.
The existing CI service account could submit builds but could not read the
remote logging service. That access failure did not establish the build cause.

The investigation reconstructed the CI upload context and ran the real
Linux/amd64 Docker build on an isolated machine. Vite reported a missing
extension-root `tsconfig.json`. The Storybook compiler config extended that
file. The checkout contained it, but the materializer omitted it from the
uploaded extension inputs.

## Smallest correction

The comparison added only the committed root compiler config to the materialized
context. The corrected full image built and passed its final file and manifest
checks. The source fix added the file to the materializer's input list.

A regression invoked the actual materializer and compared both compiler configs
with independently read committed bytes. Removing the root config from the
input list made the regression fail. Restoring it made the check pass.

## Completion and limits

After review, the merged revision passed the real deployment pipeline. The
served build receipt named that revision and build. Independent reads of the
served index and iframe matched the receipt's hashes. Browser review rendered
seven Docs pages and three examples and exercised acknowledgement, Submit and
section-navigation callbacks. The existing delivery message then gained the
verified Catalog and example links.

The upload reconstruction had a known whole-context inventory difference;
its entire context was not claimed byte-identical to CI. The one-file experiment
and later real pipeline established the correction. The receipt identified its
source as a pipeline claim with no source tree. Artifact hashes established
consistency with that receipt, not an independent source attestation. Emulated
Linux proof did not substitute for the later real CI run. Backend integration,
full journeys and business acceptance remained outside the delivered reference.

## Transfer to another repository

Discover that repository's CI owner and commands. Check the actual failing
revision and packaged inputs before using a local pass as evidence. Preserve
any unmatched environment details. A green job becomes a deployment claim only
after publication identity and the affected user operation are verified.
