# Environment comparison

Complete the rows relevant to the failing stage. Source values from the actual
run and repository definitions, not a presumed default branch or local install.

| Input | Compare and retain |
| --- | --- |
| Revision | Actual checked-out commit, source/base relationship and dirty input state |
| File set | Upload rules, ignore files, generated inputs, submodules, symlinks and modes |
| Build stages | Materializers, installation, compiler invocation and packaging order |
| Platform | Container digest or image tag, OS, architecture and emulation differences |
| Toolchain | Runtime/package manager versions, lockfile and frozen-install behaviour |
| Execution | Working directory, user, locale, non-secret environment and timeout |
| Caches | Relevant cache inputs, cache hits and whether a clean comparison was run |
| External systems | Existing credential delivery, network requirements and simulated boundaries |

For container failures, use the actual build definition and platform. A bind
mount of the whole checkout can hide missing upload inputs. Retain a manifest
of the reproduced context and the exact delta used for the passing comparison.
Check ownership and resource availability before a heavy run. Preserve foreign
containers and the host's credential configuration.

## Hosted macOS runner

For a failure only on GitHub's hosted macOS runner, run the job's command with
that image's git, Bun and Node through
[`match-macos-runner.sh`](../scripts/match-macos-runner.sh). Its usage text
lists the options; take `--git`, `--bun` and `--node` from the failing job's
image README and setup step. From this skill's directory:

```sh
ssh mac-mini 'bash -s -- --vm gh-macos-26-runner --repo OWNER/NAME --ref REF -- "bun install --frozen-lockfile && bun run check"' \
  < scripts/match-macos-runner.sh
```

- `--vm gh-macos-26-runner` runs in a throwaway clone of a Tart VM sized like
  `macos-latest`: 3 CPUs, 7 GB memory, Cirrus Labs' `macos-tahoe-base` image.
  Leave out `--vm` to run on the Mac mini itself; it is faster, but its 14
  cores can hide a timing race.
- Both match git, Bun, Node, the clean global git config and `CI=true`. Neither
  matches the runner's macOS minor version, Xcode or other preinstalled tools;
  record those as reproduction gaps.
- After changing a toolchain version, prepare the base once with
  `--vm gh-macos-26-runner --prepare` and the new version flags. Otherwise each
  clone builds it again.
- Apple allows two macOS VMs per Mac. The script refuses to start while another
  Tart VM runs. OrbStack and Docker run Linux only.

If the target cannot run locally, state why. Use the existing runner's supported
diagnostics within current authority, or return a bounded reproduction gap.
Never present an emulator, substitute service or retained-log replay as a fresh
execution on the real target.
