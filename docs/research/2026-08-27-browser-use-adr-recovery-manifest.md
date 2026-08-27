# Browser Use ADR recovery manifest

Date: 2026-08-27 (Australia/Melbourne)

Status: source evidence complete; restoration not started.

## Outcome

The Browser Use ADRs survive in the archived `claude-code-config` repository.
The archive is a clean checkout at commit
`175e1bd20c4d7470c0e5050160dbcf76d40b14cb`, and its `origin/main` resolved to
the same commit on 2026-08-27.

Use this snapshot as the byte source:

`/Users/nathanvale/code/.archive/claude-code-config-20260819/docs/adr`

The current Browser Use source is
`config/agents/skills/personal/browser-use`. Its migration copied the skill but
not the repository-level ADR set. Restoration requires a namespace decision
before files or pointers change.

## Recovery boundary

- Recover immutable source bytes from the archived commit above.
- Preserve each recorded status. Recovery does not make a superseded or
  metadata-incomplete ADR accepted.
- Resolve every bare ADR number to a filename before changing a pointer.
- Keep `0014-browser-use-prepare-and-operation-front-door.md` absent. It was a
  planned file with no object or commit in the archived repository.
- Keep `0016-runtime-continuation-guidance.md` outside this recovery. The
  historical reference names the separate `side-quest-engineering` repository.
- Choose the destination namespace before copying. Dotfiles and the retired
  repository have independent ADR number sequences.

## Recoverable corpus

`Reachability` records why each file is in scope:

- `exact`: the imported Browser Use corpus names the full path.
- `number`: the imported corpus names only the ADR number.
- `adjacent`: the ADR is Browser Use-specific and sits between referenced
  decisions, but no surviving `ADR NNNN` reference was found.

| ADR file | Archived status | Reachability | SHA-256 |
| --- | --- | --- | --- |
| `0006-warm-chrome-via-dedicated-debug-profile.md` | accepted | exact | `7170f4101116ca956dbae4e2263efd850f96e17fa293d5b309d127a4701c9030` |
| `0008-browser-use-owns-warm-chrome-binding-lifecycle.md` | superseded by 0009 | exact | `0604abbb9879b872fa370c3f440928a113f27c2e754e26e4234e40594a1e447a` |
| `0009-browser-use-fixed-cdp-convention-and-runtime-proof.md` | accepted | exact | `89cdbf80990f40c8aa2bca700e1e5d27ffef9ac5c37687de41180e72f0b2c39b` |
| `0011-skill-prose-names-tools-clis-resolve-invocation.md` | accepted | exact | `cbfbf041a65974cdd38bff91a7436d8fac17bdf1c43ec9b732180cdb444e55c2` |
| `0012-browser-adapter-router-uses-evidence-first-routing.md` | accepted | exact | `091eba27e1519894e2f899d2dcd51a2a4c1c53d786ceb68728b85c2e8d5d4c08` |
| `0013-router-research-recovery-uses-diagnostic-trail.md` | accepted | exact | `0d87fc1cd762447d79f93ba6d28442d7332bee45ec17534ebb5b4156e745bb7c` |
| `0019-one-password-token-scope-is-browser-automation-vault-authority.md` | accepted | adjacent | `9431480daea9eb6aeb1b72ce831e1df96234df8f1c3fb2b32f71eef3c355795d` |
| `0020-browser-use-local-broker-is-human-approval-authority.md` | accepted | adjacent | `735d690534c6ab589846bb92235285a48bc6c688db4f299ea0d43ef19da16ecc` |
| `0021-only-disposable-retrieval-and-delivery-helpers-may-see-browser-secrets.md` | accepted | exact | `fd2cab8a791ad4f061c89113c40c193cc300dea55ca92e236867af7ca07b937b` |
| `0022-browser-secret-delivery-uses-app-sandbox-xpc.md` | accepted | exact | `49674a0a7bab25046b45d975e4721427aa36719806b9ff4a72222c4994e14dfb` |
| `0023-browser-automation-token-uses-private-data-protection-keychain-group.md` | accepted | exact | `fc24416622e207a04f14d5d9d688ace88306b725354afdcfef09c074a7aecf44` |
| `0024-autonomous-runs-use-bounded-standing-authorization.md` | accepted | adjacent | `0568291bb60258a9d12ea1b9646e9022f84e52134042cc8fd5b74d21ec285c61` |
| `0025-browser-use-is-schedulable-not-a-scheduler.md` | accepted | adjacent | `ef559ca16cf775cf5f9e1d3dafd3350ef31819754df9bdf50c4dd24f5c245f4c` |
| `0026-human-identity-attestation-is-one-run-only.md` | accepted | number | `e47d6a4e51f0b13e7655c34411826bb17a7878d167ea4621db79c1843b433671` |
| `0027-browser-use-security-is-one-product-with-three-targets.md` | accepted | exact | `6148a04e5d59a1b85e4081a119b7e4e8e882f0dd3a67cf285b09a2b03ec2ac51` |
| `0028-auth-u3-splits-pure-contract-from-signed-native-capability.md` | accepted | number | `58661dfaf8708b15599654ec2a2b8a79457bf5ff5f22f3de66837a4a57758889` |
| `0029-candidate-import-proposes-live-vault-evidence-binds.md` | accepted | number | `5cc16f3dbe5cdaa87b8841207b4b4f7035407c3f290d5603518ae48708946e68` |
| `0030-environment-injected-op-lane-is-lower-assurance.md` | accepted | number | `2418c5827870ed2df4eda73f911e0b27e45e2e848ae0036f70ac1b0ef1787324` |
| `0031-browser-use-delegates-browser-mechanics-to-adapters.md` | accepted | exact and number | `fb01d0e8e415a7df8c78ddb7e31fca4f13fc2909cd40f993ae41886dc957b3dc` |
| `0031-private-runbook-catalog-activates-a-runbook-generation.md` | status metadata absent | number | `bf7012de5dbc6f52c52f5058be6182890ea360b394e5c0f79d095f13c761e208` |
| `0032-runbook-authoring-validates-and-applies-complete-documents.md` | status metadata absent | number | `2633b3a38e02b4607c7d5bf4607779e20493b646c0ca4c2164aa7ccf5de9f60c` |
| `0033-reviewed-actions-have-a-separate-authoring-front-door.md` | status metadata absent | number | `56f020ab53c5fcf13cdb2e8755173df6be0d06b23fe39bb7f2e5be2fb109987b` |
| `0034-session-release-is-an-adapter-registry-mechanic.md` | accepted | adjacent | `8fbb1a59201d5b6f913fabaef00d65a2b40f8c990c638887d654cbd9ce34c834` |

## Unrecoverable or external references

| Referenced path | Classification | Required action |
| --- | --- | --- |
| `docs/adr/0014-browser-use-prepare-and-operation-front-door.md` | Planned in `2026-06-04-001-feat-browser-use-prepare-operation-front-door-plan.md`; never committed and absent from all archived refs and objects. | Treat the plan entry as unrealized scope. Do not reconstruct an accepted ADR from the plan. |
| `docs/adr/0016-runtime-continuation-guidance.md` | Explicitly attributed to `side-quest-engineering` by the referring plan. | Recover from that repository only if the historical plan must become self-contained. Do not import it as a Browser Use ADR. |

## Migration hazards

### Duplicate ADR number

The retired repository contains two different files numbered 0031:

- `0031-browser-use-delegates-browser-mechanics-to-adapters.md` owns
  adapter-native delegation.
- `0031-private-runbook-catalog-activates-a-runbook-generation.md` owns the
  source-to-runtime runbook generation model.

Current prose uses bare `ADR 0031` for both meanings. Restoration must replace
those references with descriptive titles or full filenames.

### Independent ADR namespaces

Dotfiles already owns ADRs 0001 to 0003. The retired repository has unrelated
ADRs with the same numbers and later duplicate numbers. Copying its complete
`docs/adr` directory into Dotfiles would create one directory with two
independent sequences and ambiguous human references.

### Broken relative links

The retired source path was `skills/browser-use`. The current source path is
`config/agents/skills/personal/browser-use`. Links such as
`../../../docs/adr/...` now resolve under `config/agents/skills/docs/adr`, not
the Dotfiles root. Copying files without rewriting those links leaves the
corpus broken.

### Status drift

ADR 0008 is explicitly superseded. ADRs 0031 Private Runbook Catalog, 0032,
and 0033 have no status or date frontmatter in the archived source. Preserve
that evidence gap until a separate decision records their status.

The current Browser Use context also retires the Browser Adapter Router while
ADRs 0012 and 0013 remain marked accepted. Reconcile that contradiction before
presenting either ADR as a current runtime owner.

## Restoration gates

1. Choose a collision-free destination for the recovered Browser Use ADRs.
   Compare a domain namespace such as `docs/adr/browser-use/` with a
   skill-local namespace. Record the owner before copying.
2. Classify each recoverable file as current, superseded, historical, or
   status-unresolved against the imported runtime and current `CONTEXT.md`.
3. Copy only the approved set from archived commit
   `175e1bd20c4d7470c0e5050160dbcf76d40b14cb`.
4. Verify every copied file against the SHA-256 value in this manifest.
5. Rewrite each live pointer to a collision-free path. Replace bare `ADR 0031`
   references with the exact decision title or filename.
6. Resolve or explicitly retain every historical broken link. Do not silently
   redirect an old reference to a different decision.
7. Run a complete Browser Use ADR-reference scan and the smallest tests that
   enforce the affected ownership boundaries.

## Proof commands

Confirm the archived snapshot and remote agreement:

```bash
archive=/Users/nathanvale/code/.archive/claude-code-config-20260819
git -C "$archive" rev-parse HEAD
git -C "$archive" ls-remote --heads origin main
```

Find every explicit ADR path and bare ADR number in the imported corpus:

```bash
rg -n 'docs/adr/[0-9]{4}-|ADR[[:space:]]+[0-9]{4}' \
  config/agents/skills/personal/browser-use
```

Verify a recovered file:

```bash
shasum -a 256 <recovered-file>
```

Completion requires every restored file to match this manifest, every live
pointer to resolve, every ambiguity to have an explicit owner, and no
unapproved ADR to acquire accepted status.
