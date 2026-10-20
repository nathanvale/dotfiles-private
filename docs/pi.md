# Pi setup

Pi is optional on desktop and server profiles. Its vendor installer owns the
executable and updates; it is separate from the AI rescue phase and Brewfile.
Use Node.js 22.19 or newer from the existing Mise toolchain.

## Install

Follow the [official quickstart](https://pi.dev/docs/latest/quickstart).
Download and inspect the installer, then run it with the local command directory
first on PATH:

```sh
curl -fsSL https://pi.dev/install.sh -o /tmp/pi-install.sh
less /tmp/pi-install.sh
PATH="$HOME/.local/bin:$PATH" sh /tmp/pi-install.sh
command -v pi
pi --version
```

The PATH ordering keeps the vendor's executable link in `~/.local/bin`.
`~/bin` links into this repository, so allowing the installer to choose it would
put a machine-local executable link in the checkout. Existing shell startup
already includes `~/.local/bin`; no extra shell configuration is needed.
Managed releases live under `~/.pi/agent/install`. Update with `pi update`.

## Instructions and skills

The symlink manager owns `~/.pi/agent/AGENTS.md`, pointing at
`config/agents/AGENTS.md`, the same plain-text startup pointer used by Codex.
Apply the reviewed configuration through `./setup.sh symlinks`; inspect existing
conflicts before replacing anything. Keep credentials, sessions, trust decisions,
and generated extensions in Pi's machine-local directory.

Pi discovers shared `~/.agents/skills` and trusted project `.agents/skills`
natively. Claude and Codex plugin installations do not automatically become Pi
skills. Their hooks and browser tools do not transfer either.

## Sign in and qualify

Choose the provider and account before signing in. Start `pi` in a scratch
directory and use `/login` for the chosen provider. Do not copy another harness's
credentials. Check readiness without printing credentials:

```sh
pi auth check --provider openai --json
pi --list-models
herdr-projects models pi
```

Use the selected provider in the readiness check. Only use model identifiers
present in Pi's authenticated list. An empty list leaves model selection
unqualified, even if a caller misparses its human-readable message.
Listing a model does not prove the account can run it. Confirm a completed
response, then save that verified choice with `/model` and `Ctrl+S`. Board workers
started with `--worker.agent pi` inherit Pi's saved default.
After sign-in, complete a harmless direct turn in a scratch directory:

```sh
pi -p --no-session --no-tools "Reply with OK"
```

## Herdr and the task board

After approving activation, install the vendor-owned state integration:

```sh
herdr integration install pi
herdr integration status
```

Use `herdr agent` and `herdr-projects --help` for installed launch syntax.
Both support Pi natively; no wrapper or source patch is required. Select Pi for
an explicitly authorized smoke task with `--worker.agent pi`. This preserves
Pi's own default model. Confirm its actual provider, model, effort, completed
turn, report, and board review before using it for ordinary work. Leave repository
and global worker defaults unchanged during qualification.

Pi has no built-in per-tool approvals or sandbox. The board requires full access
for Pi. Project skills can trigger a startup trust dialog; review the exact
repository and use `/trust` there before unattended board launches. Keep the
global `defaultProjectTrust` at its default instead of trusting every project.
See [Pi security](https://pi.dev/docs/latest/security) for the trust boundary.
