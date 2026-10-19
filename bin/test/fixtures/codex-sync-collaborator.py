"""Harmless Phase 6 collaborator; config preservation has its own process proof."""
import os
from pathlib import Path
import sys

records = Path(os.environ["RECORD_DIR"])
with (records / "calls").open("a") as stream:
    stream.write("codex-sync-called:" + " ".join(sys.argv[1:]) + "\n")
sys.exit(41 if (records / "codex-sync-fail").exists() else 0)
