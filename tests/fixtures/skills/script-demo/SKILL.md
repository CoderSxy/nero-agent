---
name: script-demo
description: Offline python3 skill that reads /skill/assets/data.json and writes result.csv in the thread cwd.
license: MIT
compatibility: sandbox-python3
metadata:
  fixture: script-demo
user-invocable: true
---

# Script demo

Use `run_skill_script` with path `scripts/to_csv.py`.
The script reads `/skill/assets/data.json` and writes `result.csv` under the current thread directory.
Do not pip install. Do not call the network.
