#!/usr/bin/env python3
"""Apply the portable declaration through Codex's native plugin manager."""

import argparse
import copy
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[2]


def read_config(path):
    return tomllib.loads(path.read_text()) if path.exists() else {}


def declaration():
    source = read_config(ROOT / "config/agents/codex/shared.toml")
    if source.get("schema_version") != 1:
        raise ValueError("Unsupported shared declaration schema")
    if not re.fullmatch(r"\d+\.\d+\.\d+", source["cli_release"]):
        raise ValueError("Expected an exact CLI release")
    # This declaration cannot broaden permissions or deliver credentials.
    if set(source["config"]) - {"model", "model_reasoning_effort", "personality", "features"}:
        raise ValueError("Unsupported shared setting")
    if set(source["config"].get("features", {})) - {"hooks"}:
        raise ValueError("Unsupported shared feature")
    for name, market in source["marketplaces"].items():
        raw = market["source"]
        if raw.startswith("dotfiles:"):
            path = (ROOT / raw.removeprefix("dotfiles:")).resolve()
            if not path.is_relative_to(ROOT):
                raise ValueError("Marketplace escapes dotfiles")
            market["source"] = str(path)
        elif not raw.startswith("https://github.com/"):
            raise ValueError("Unsupported marketplace source")
        if not re.fullmatch(r"[a-z0-9-]+", name):
            raise ValueError("Invalid marketplace name")
    return source


def run(argv, *, input_text=None):
    result = subprocess.run(argv, input=input_text, text=True, capture_output=True, timeout=600)
    if result.returncode:
        # Native stderr can contain private configuration. Never put it in
        # the public completion. Report the safe command identity instead.
        raise RuntimeError(f"Native command failed: {' '.join(argv[:3])} (exit {result.returncode})")
    return result.stdout


def merged(current, shared):
    result = copy.deepcopy(current)
    for key, value in shared.items():
        if isinstance(value, dict):
            result[key] = {**result.get(key, {}), **value}
        else:
            result[key] = value
    return result


def drift(current, shared):
    return [key for key, value in shared.items()
            if (any(current.get(key, {}).get(k) != v for k, v in value.items())
                if isinstance(value, dict) else current.get(key) != value)]


def serialize_config(current, shared):
    script = '''const x = JSON.parse(await Bun.stdin.text());
const cfg = Bun.TOML.parse(x.current);
for (const [k,v] of Object.entries(x.shared)) {
  cfg[k] = v && typeof v === "object" ? {...(cfg[k] ?? {}), ...v} : v;
}
process.stdout.write(Bun.TOML.stringify(cfg));'''
    text = run(["bun", "-e", script], input_text=json.dumps({"current": current, "shared": shared}))
    if tomllib.loads(text) != merged(tomllib.loads(current), shared):
        raise ValueError("TOML conversion changed an unrelated setting")
    return text


def write_config(path, original, shared):
    rendered = serialize_config(original, shared)
    fd, tmp = tempfile.mkstemp(prefix=".dotfiles-codex-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(rendered)
            stream.flush()
            os.fsync(stream.fileno())
        if (path.read_text() if path.exists() else "") != original:
            raise ValueError("Codex config changed concurrently; preview again")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def expected_versions(source):
    expected = {}
    for selector in source["plugins"]:
        name, market = selector.split("@")
        if market == "personal":
            manifest = ROOT / "config/agents/plugins" / name / ".codex-plugin/plugin.json"
            expected[selector] = json.loads(manifest.read_text())["version"]
        else:
            expected[selector] = source["plugin_versions"][selector]
    return expected


def observe(binary, source, config):
    actual = run([str(binary), "--version"]).strip()
    installed = json.loads(run([str(binary), "plugin", "list", "--json"]))["installed"]
    indexed = {p["pluginId"]: p for p in installed}
    expected = expected_versions(source)
    pending = [key for key, version in expected.items()
               if key not in indexed or not indexed[key]["enabled"] or indexed[key]["version"] != version]
    markets = config.get("marketplaces", {})
    pending_markets = [name for name, m in source["marketplaces"].items()
                       if markets.get(name, {}).get("source") != m["source"]
                       or markets.get(name, {}).get("ref") != m.get("ref")]
    return {"cli": actual, "cli_matches": actual == "codex-cli " + source["cli_release"],
            "settings": drift(config, source["config"]), "plugins": pending,
            "marketplaces": pending_markets}


def apply_plugins(binary, source):
    for market in source["marketplaces"].values():
        argv = [str(binary), "plugin", "marketplace", "add", market["source"], "--json"]
        if "ref" in market:
            argv += ["--ref", market["ref"]]
        run(argv)
    for selector in source["plugins"]:
        run([str(binary), "plugin", "add", selector, "--json"])


def install_cli(source, operation):
    installer = operation / "install.sh"
    run(["curl", "-fsSL", "https://chatgpt.com/codex/install.sh", "-o", str(installer)])
    # The native installer owns checksums, release selection, locks and links.
    env = os.environ.copy()
    env["CODEX_NON_INTERACTIVE"] = "1"
    env["CODEX_INSTALL_DIR"] = str(Path.home() / ".local/bin")
    for key in ("CODEX_INSTALL_DAEMON_ONLY", "CODEX_INSTALL_DEFER_SELECTION"):
        env.pop(key, None)
    result = subprocess.run(["sh", str(installer), "--release", source["cli_release"]],
                            env=env, text=True, capture_output=True, timeout=600)
    if result.returncode:
        raise RuntimeError(f"Managed Codex installer failed (exit {result.returncode})")


def apply(source, config_path, binary, report):
    if not shutil.which("bun"):
        raise ValueError("Bun is required; apply the dotfiles toolchain first")
    state = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
    if not state.is_absolute():
        raise ValueError("XDG_STATE_HOME must be absolute")
    state = state / "dotfiles/codex"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "sync.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another Codex sync is running")
        operation = Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime("%Y%m%d-%H%M%S-"), dir=state))
        report["backup"] = str(operation)
        config_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        original = config_path.read_text() if config_path.exists() else ""
        backup = operation / "config.toml.before"
        backup.write_text(original)
        backup.chmod(0o600)
        before = tomllib.loads(original)
        report["effects"] = "partial"
        if not binary.exists() or run([str(binary), "--version"]).strip() != "codex-cli " + source["cli_release"]:
            install_cli(source, operation)
        write_config(config_path, original, source["config"])
        apply_plugins(binary, source)
        after = read_config(config_path)
        # Native commands may touch only the selected plugin and marketplace
        # entries. Verify the rest independently after the operation.
        protected = copy.deepcopy(before)
        observed = copy.deepcopy(after)
        for cfg in (protected, observed):
            for key in source["config"]:
                if isinstance(source["config"][key], dict):
                    for item in source["config"][key]:
                        cfg.get(key, {}).pop(item, None)
                    if not cfg.get(key):
                        cfg.pop(key, None)
                else:
                    cfg.pop(key, None)
            for category, names in (("plugins", source["plugins"]), ("marketplaces", source["marketplaces"])):
                for key in names:
                    cfg.get(category, {}).pop(key, None)
                if not cfg.get(category):
                    cfg.pop(category, None)
        if observed != protected:
            raise ValueError("Native plugin management changed protected settings; inspect backup")
        report["drift"] = observe(binary, source, after)
        report["effects"] = "applied"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--preview", action="store_true", help="Inspect without changing configuration")
    group.add_argument("--apply", action="store_true", help="Back up, merge shared settings and install declared plugins")
    group.add_argument("--check", action="store_true", help="Fail when the declaration is not satisfied")
    parser.add_argument("--json", action="store_true", help="Emit one completion record")
    args = parser.parse_args()
    report = {"status": "error", "effects": "none"}
    try:
        source = declaration()
        codex_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
        if not codex_home.is_absolute() or codex_home.is_symlink():
            raise ValueError("CODEX_HOME must be an absolute, non-symlink directory")
        config_path = codex_home / "config.toml"
        if config_path.is_symlink():
            raise ValueError("Refusing a symlinked config.toml")
        binary = codex_home / "packages/standalone/current/bin/codex"
        if args.apply:
            apply(source, config_path, binary, report)
        elif binary.exists():
            report["drift"] = observe(binary, source, read_config(config_path))
        else:
            report["drift"] = {"cli_matches": False, "cli": "missing", "settings": [], "plugins": source["plugins"], "marketplaces": list(source["marketplaces"])}
        report["status"] = "synced" if report["drift"]["cli_matches"] and not any(report["drift"][k] for k in ("settings", "plugins", "marketplaces")) else "drift"
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
        report["error"] = str(error) if not isinstance(error, subprocess.TimeoutExpired) else "Native operation timed out; inspect state before retrying"
    if args.json:
        print(json.dumps(report))
    else:
        print("Codex sync: " + report["status"])
        if "drift" in report:
            for key, value in report["drift"].items():
                print(f"  {key}: {value}")
        if "backup" in report:
            print("  backup: " + report["backup"])
        if "error" in report:
            print("  error: " + report["error"])
    return 0 if report["status"] == "synced" or (report["status"] == "drift" and not args.check and not args.apply) else 1


if __name__ == "__main__":
    sys.exit(main())
