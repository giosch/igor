# Review the result

Use `status` and `exitCode` for supervisor outcomes. Use `agentCompleted` and `agentOutcome` for the harness and self-reported success. An exit code of 1 with `status` equal to `completed` can represent a task the agent reported as failed.

`igor review JOB_ID --json` returns `result`, `diff` and `verification`. The summary's `agent.commands` contains observed Pi shell tool results. `independent` is the latest check for this patch, or `null`. `independentlyVerified` is true when that check passed. Use the check command, exit status, and output to assess the acceptance criteria.

Inspect `result.filesChanged`, `result.artifacts.patchComplete`, and the diff. A failed or interrupted job may yield a partial or empty artifact. `igor verify` requires a complete patch and restores the initial snapshot, including captured dirty and untracked files. Review binary changes, renames and executable modes. Apply only after review and independent verification.
