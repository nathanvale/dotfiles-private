#!/usr/bin/env python3
"""Refresh the pinned Codex model catalog.

Each entry is the upstream OpenAI Codex ``ModelInfo`` for one slug, taken
unchanged from the model catalog of one pinned release:

* ``gpt-5.5`` from ``rust-v0.153.4``; and
* ``gpt-6.1-sol`` from ``rust-v0.165.0``.

https://raw.githubusercontent.com/openai/codex/<tag>/codex-rs/models-manager/models.json

A slug is never copied from another slug's entry. The generated artifact is
derived from the OpenAI Codex repository; retain the repository's Apache-2.0
license terms with the artifact.
"""

from __future__ import annotations

import json
import sys
from urllib import error as urllib_error
from urllib import request as urllib_request


# (slug, Codex release tag). Order is the order of the emitted catalog.
PINNED_MODELS = (
    ("gpt-5.5", "rust-v0.153.4"),
    ("gpt-6.1-sol", "rust-v0.165.0"),
)
SOURCE_URL = "https://raw.githubusercontent.com/openai/codex/{tag}/codex-rs/models-manager/models.json"


def _usage() -> str:
    pins = ", ".join(f"{slug} from {tag}" for slug, tag in PINNED_MODELS)
    return f"Usage: {__file__} [--help]\n\nFetch the pinned Codex catalogs and emit only: {pins}."


def _fetch_catalog(tag: str) -> dict[str, object]:
    request = urllib_request.Request(
        SOURCE_URL.format(tag=tag),
        headers={"Accept": "application/json"},
    )
    with urllib_request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        raise ValueError("source catalog has no models list")
    return payload


def _load_source() -> dict[str, object]:
    catalogs: dict[str, dict[str, object]] = {}
    models = []
    for slug, tag in PINNED_MODELS:
        if tag not in catalogs:
            catalogs[tag] = _fetch_catalog(tag)
        matches = [
            model
            for model in catalogs[tag]["models"]
            if isinstance(model, dict) and model.get("slug") == slug
        ]
        if len(matches) != 1:
            raise ValueError(f"expected exactly one {slug} model in {tag}")
        model = matches[0]
        messages = model.get("model_messages")
        if not isinstance(messages, dict):
            raise ValueError(f"{slug} is missing model_messages")
        # Instructions are either the legacy base_instructions string or the
        # newer model_messages.instructions_template.
        if not isinstance(model.get("base_instructions"), str) and not isinstance(
            messages.get("instructions_template"), str
        ):
            raise ValueError(f"{slug} has no instructions")
        levels = model.get("supported_reasoning_levels")
        if not isinstance(levels, list) or not levels:
            raise ValueError(f"{slug} lists no supported_reasoning_levels")
        # Do not reconstruct or normalize ModelInfo.  Appending this object
        # keeps every upstream field, including the instruction and message
        # payloads.
        models.append(model)
    return {"models": models}


def main(argv: list[str]) -> int:
    if argv in (["--help"], ["-h"]):
        print(_usage())
        return 0
    if argv:
        print(f"error: unrecognized arguments: {' '.join(argv)}", file=sys.stderr)
        print(_usage(), file=sys.stderr)
        return 2

    try:
        catalog = _load_source()
        json.dump(catalog, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    except (OSError, ValueError, urllib_error.URLError) as exc:
        print(f"error: unable to refresh pinned Codex catalog: {type(exc).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
