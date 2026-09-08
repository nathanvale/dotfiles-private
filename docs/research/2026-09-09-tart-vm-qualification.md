# Tart clean-Mac VM qualification

Date: 2026-09-09 (Australia/Melbourne)

Status: research complete; no package, image or VM change performed.

## Decision

Use Tart for the reproducible-Mac clean qualification. Keep UTM outside this
ticket unless a separate package tidy-up proves it has no remaining use.

The current route is:

- Tart `2.36.0` from `openai/tools/tart`.
- Tahoe vanilla image `26.6.2`, pinned by OCI digest
  `sha256:eeec54bfe1f076e27786c5d92b89187a05b1d109b5071eb2dcdf02d596e34640`.
- One untouched local baseline and one disposable qualification clone.
- 4 virtual CPUs, 8 GB memory and a 50 GB virtual disk.
- No writable host-home or production-checkout mount.

This best fits MAC-A because Tart provides a standalone CLI, OCI image
identity, digest-qualified pulls, APFS copy-on-write cloning and documented SSH
access. [Tart clone source](https://github.com/openai/tart/blob/2.36.0/Sources/tart/Commands/Clone.swift),
[digest reference parser](https://github.com/openai/tart/blob/2.36.0/Sources/tart/OCI/RemoteName.swift),
and [official SSH route](https://github.com/openai/tart/blob/2.36.0/docs/quick-start.md#ssh-access).

## Current owner, install route and license

Tart moved from `cirruslabs/tart` to `openai/tart` in 2026. The current
upstream README and generated Homebrew formula both name this installation
command:

```bash
brew install openai/tools/tart
```

The formula currently packages Tart `2.36.0`, verifies release archive SHA-256
`c72a8ab8d78a6498a1e42688b1a1ec6c512ce46ca35a3a3be130c3de1440c7e8`,
requires macOS Ventura or newer and installs `openai/tools/softnet` as a
dependency. [Pinned Homebrew formula](https://github.com/openai/homebrew-tools/blob/2b0b3deb1c45b6a829e358fa5d1ae28f4036d141/Formula/tart.rb)
and [Tart 2.36.0 release](https://github.com/openai/tart/releases/tag/2.36.0).

The corresponding narrow Brewfile declaration is a desktop VM-host opt-in:

```ruby
if profile == "desktop" && ENV.fetch("HOMEBREW_DOTFILES_VM_HOST", "0") == "1"
  brew "openai/tools/tart", trusted: true
end
```

A fully qualified formula installs from its tap and trusts only that item;
Homebrew Bundle supports item-level `trusted: true`. This is narrower than
trusting every current and future item in the tap. [Homebrew tap trust](https://docs.brew.sh/Tap-Trust)
and [Brewfile trust syntax](https://docs.brew.sh/Brew-Bundle-and-Brewfile#trusted).
The additional host flag matters because the normal `desktop` profile also
applies inside a clean desktop guest. It keeps the VM runner on the physical
host and out of the system being qualified. The existing setup phase preserves
ambient `HOMEBREW_` variables, so the opt-in needs no setup-script change and
the normal desktop verifier must not require Tart.

Tart `2.36.0` uses `FSL-1.1-ALv2`. The license expressly permits internal use
and non-commercial research. It prohibits making Tart available to others as a
commercial product or service that competes with Tart or another licensor
offering based on Tart. Each version receives an Apache 2.0 future license two
years after that version is made available. The installed Softnet dependency
uses the same license and also expressly permits internal use. [Tart 2.36.0
license](https://raw.githubusercontent.com/openai/tart/2.36.0/LICENSE) and
[Softnet 0.23.0 license](https://raw.githubusercontent.com/openai/softnet/0.23.0/LICENSE).

Therefore this personal, internal qualification is permitted by the current
Tart and Softnet terms, with no paid CPU threshold in those current license
files. This is a source interpretation, not legal advice.

The rendered `tart.run` pages are stale as of this research. Their quick start
still says `cirruslabs/cli/tart`, and their licensing page still describes the
old Cirrus Labs 100-core scheme. Tart `2.32.1` carried that older Fair Source
0.9 license; `2.33.0` and the current `2.36.0` already carry OpenAI's
FSL-1.1-ALv2. Use the versioned repository license and current generated
formula as authority. [Stale rendered quick start](https://tart.run/quick-start/),
[stale licensing page](https://tart.run/licensing/), [Tart 2.32.1
license](https://raw.githubusercontent.com/openai/tart/2.32.1/LICENSE), and
[Tart 2.33.0 license](https://raw.githubusercontent.com/openai/tart/2.33.0/LICENSE).

## Image identity and resource envelope

The images remain published under `ghcr.io/cirruslabs` after the Tart source
and formula moved to OpenAI. For this ticket use:

```text
ghcr.io/cirruslabs/macos-tahoe-vanilla:26.6.2
ghcr.io/cirruslabs/macos-tahoe-vanilla@sha256:eeec54bfe1f076e27786c5d92b89187a05b1d109b5071eb2dcdf02d596e34640
```

On 9 September 2026, the public registry showed `latest` and `26.6.2` at that
same digest. The exact version tag must be recorded for readability, but the
digest is the immutable execution input. Do not run qualification from the
mutable `latest` tag. [Official GHCR package and digest](https://github.com/cirruslabs/macos-image-templates/pkgs/container/macos-tahoe-vanilla)
and [Tart digest syntax](https://github.com/openai/tart/blob/2.36.0/Sources/tart/OCI/RemoteName.swift#L1-L96).

The image's source change pins Apple's macOS 26.6.2 build `25G83` restore IPSW
and declares 4 CPUs, 8 GB memory and a 50 GB disk. The registry manifest
reported a 50,000,000,000-byte uncompressed disk and 23.99 GB of compressed
layers, consistent with Tart's guidance to expect about a 25 GB download.
[Pinned vanilla template](https://github.com/cirruslabs/macos-image-templates/blob/4849509b2dafd6f25f801da038a1e8bb1c8a1344/templates/vanilla-tahoe.pkr.hcl#L14-L22),
[source change](https://github.com/cirruslabs/macos-image-templates/commit/4849509b2dafd6f25f801da038a1e8bb1c8a1344),
and [Tart download guidance](https://github.com/openai/tart/blob/2.36.0/README.md#usage).

`vanilla` means no additional software is preinstalled, unlike `base`, which
already includes Homebrew and other tools. It is clean enough to expose hidden
toolchain bootstrap dependencies. It is not an unmodified stock macOS image:
the published template enables Remote Login, auto-login and passwordless sudo,
and disables Gatekeeper. Record these baseline preparations in MAC-A. Treat
Gatekeeper and other attended permission behavior as a physical-Mac proof gap,
not as proven by this VM. [Image variant definitions](https://github.com/cirruslabs/macos-image-templates/blob/4849509b2dafd6f25f801da038a1e8bb1c8a1344/README.md#macos-packer-templates-for-tart)
and [vanilla preparation](https://github.com/cirruslabs/macos-image-templates/blob/4849509b2dafd6f25f801da038a1e8bb1c8a1344/templates/vanilla-tahoe.pkr.hcl#L90-L135).

Apple's Tahoe license separately permits up to two additional macOS copies or
instances on an Apple-branded computer already running macOS for software
development, development testing or personal non-commercial use. The proposed
baseline plus one disposable clone stays within two guest copies. Delete or
reuse that clone before creating another; do not retain a baseline plus two
qualification clones. [Apple macOS Tahoe 26 license, section 2B(iii)](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf).

## Tart compared with the already-declared UTM

UTM remains a capable interactive VM application and supports macOS guests on
Apple Silicon. Its official macOS path uses the new-VM wizard, either
automatically downloading the latest compatible IPSW or accepting a selected
IPSW. Its CLI can clone, start without saving, query status and execute guest
commands. [UTM macOS guest guide](https://docs.getutm.app/guest-support/macos/),
[UTM scripting guide](https://docs.getutm.app/scripting/scripting/), and
[`utmctl` 4.7.5 source](https://github.com/utmapp/UTM/blob/v4.7.5/utmctl/UTMCtl.swift#L24-L42).

For this exact qualification, Tart has the stronger contract:

| Requirement | Tart | UTM |
| --- | --- | --- |
| Clean macOS source | Published `vanilla` image with no development tools | Wizard can install from a selected IPSW |
| Provenance pin | OCI tag plus immutable digest | Record and hash the IPSW and UTM bundle manually |
| Baseline clone | Standalone CLI, APFS copy-on-write clone | `utmctl clone` duplicates an existing VM |
| Disposable run | Clone can be deleted after evidence capture | `utmctl start --disposable` does not save writes |
| Remote automation | Standalone Tart commands plus documented SSH | `utmctl` wraps Apple Events and explicitly does not work from SSH or before login |
| Registry workflow | Native pull and clone from an OCI reference | No documented OCI image workflow |

The UTM limitations in this table are bounded inferences from its current
official documentation and CLI source, not claims that custom UTM automation
is impossible. UTM can implement the journey with more manual provenance and
login-session preparation. Tart directly owns those seams. [`utmctl` clone](https://github.com/utmapp/UTM/blob/v4.7.5/utmctl/UTMCtl.swift#L503-L526),
[`utmctl` disposable start](https://github.com/utmapp/UTM/blob/v4.7.5/utmctl/UTMCtl.swift#L232-L258),
and [login-session boundary](https://github.com/utmapp/UTM/blob/v4.7.5/utmctl/UTMCtl.swift#L118-L132).

The dotfiles Brewfile already declares `cask "utm"`. Homebrew recorded UTM
`4.7.5` locally during this inspection, but `/Applications/UTM.app` and
`utmctl` were absent. That live drift makes UTM unavailable without repair,
despite its declaration and receipt. It does not justify removing UTM within
this ticket.

## Proposed bounded execution

After foreground approval for the Brewfile change, package installation and
resource allocation:

1. Declare `openai/tools/tart` through the desktop VM-host opt-in, then install
   it with `HOMEBREW_DOTFILES_VM_HOST=1`.
2. Record `tart --version`, formula identity, formula SHA-256 and the Softnet
   dependency identity.
3. Resolve `26.6.2` against GHCR again and require the recorded digest above.
4. Clone that digest once as the untouched local baseline.
5. Clone the baseline once for qualification. Do not mount host home or the
   production checkout.
6. Retrieve the approved dotfiles revision inside the guest, then execute and
   retain the MAC-A through MAC-D evidence.
7. Delete or recycle only the named disposable clone after its retention and
   cleanup approvals. Preserve the untouched baseline for the second clean
   reconstruction.

No installation, Brewfile edit, image pull, VM creation, cleanup, commit or
push was performed during this research.

Before implementation, extend the existing Brewfile evaluator to prove three
cases: an ordinary desktop omits Tart, a server omits Tart even when the host
flag is set, and an opted-in desktop emits exactly one trusted Tart formula.

## Read-only proof

The image digest, tags and manifest size were read through the public GHCR OCI
Distribution API. Local checks inspected the Brewfile, Homebrew receipts,
`/Applications/UTM.app`, `utmctl` and `tart`. They observed:

```text
tart: absent
openai/tools tap: absent
UTM 4.7.5 Homebrew receipt: present
/Applications/UTM.app: absent
utmctl: absent
```
