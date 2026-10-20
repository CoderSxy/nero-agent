#!/usr/bin/env python3
"""Offline fixture: /skill/assets/data.json → result.csv in thread cwd."""
from __future__ import annotations

import csv
import json
from pathlib import Path

src = Path("/skill/assets/data.json")
data = json.loads(src.read_text(encoding="utf-8"))
rows = data["rows"]

out = Path("result.csv")
with out.open("w", encoding="utf-8", newline="") as fh:
    writer = csv.DictWriter(fh, fieldnames=["id", "name"])
    writer.writeheader()
    writer.writerows(rows)

print(f"wrote {out.resolve()} rows={len(rows)}")
