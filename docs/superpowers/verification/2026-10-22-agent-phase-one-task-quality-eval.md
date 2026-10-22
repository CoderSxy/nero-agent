# 任务质量评测 fixture

- passed: 20
- skipped: 0
- blocked: 0
- hardFailures: 0
- price: null
- elapsedMs: 440

- weather-complete: passed actual=complete modelCalls=2
- weather-temperature-only: passed actual=complete modelCalls=2
- weather-humidity: passed actual=complete modelCalls=2
- weather-condition-missing: passed actual=partial modelCalls=2
- weather-precipitation-missing: passed actual=partial modelCalls=2
- weather-range-invalid: passed actual=partial modelCalls=2
- weather-humidity-hours-missing: passed actual=partial modelCalls=2
- weather-code-unknown: passed actual=partial modelCalls=2
- gateway-ignores-schema: passed actual=complete modelCalls=2
- forced-tool-unsupported: passed actual=complete modelCalls=2
- wrapped-tool-schema: passed actual=complete modelCalls=2
- blob-missing: passed actual=complete modelCalls=1
- release-tree-missing: passed actual=complete modelCalls=1
- cross-user-diagnosis: passed actual=complete modelCalls=1
- file-request: passed actual=failed modelCalls=1
- ordinary-answer: passed actual=complete modelCalls=1
- budget-stop: passed actual=failed modelCalls=1
- duplicate-outcome: passed actual=partial modelCalls=2
- history-style-followup: passed actual=complete modelCalls=1
- html-skill-attachment: passed actual=complete modelCalls=1
