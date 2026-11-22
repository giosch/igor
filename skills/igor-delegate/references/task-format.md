# Task prompt

State the objective in one sentence. Include the current behavior, desired behavior and exact reproduction or fixture. Name the files in scope, relevant read-only documentation, public interfaces to preserve and expected tests.

For example, ask the worker to fix `clamp(value, lower, upper)` in `clamp.js`, preserve the existing test, run `node --test`, and report the result. Acceptance includes values below, inside and above the interval. The orchestrator can independently verify additional negative and fractional cases.
