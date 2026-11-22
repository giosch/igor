# Review the result

Use `status` and `exitCode` for supervisor outcomes. Use `agentCompleted` and `agentOutcome` for the harness and self-reported success. An exit code of 1 with `status` equal to `completed` can represent a task the agent reported as failed.

`verification.commands` contains observed shell tool results. Check the command, working assumptions and reported outcome. `independentlyVerified` stays false in Igor's result. Record your own verification evidence separately.

Inspect `filesChanged`, `artifacts.patchComplete`, and the diff. A failed or interrupted job may yield a partial or empty artifact. The initial snapshot captures dirty source bytes, so HEAD alone may be insufficient to reconstruct the base. Review binary changes, renames and executable modes. Apply only after review and independent verification.
