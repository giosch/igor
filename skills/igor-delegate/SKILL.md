---
name: igor-delegate
description: Delegate a bounded, independently verifiable coding task to a local Igor worker, track it, and review its Git patch.
---

# Delegate a coding task to Igor

Choose a task with a small source boundary and a concrete verification command. Consult [delegation policy](references/delegation-policy.md) before selecting inputs. The worker receives a copy of the current files, including local edits selected by Igor's snapshot policy.

1. Locate the source root containing every file needed for the task. Select a separate documentation directory when the worker needs reference material. Read the relevant tests and define observable acceptance criteria.
2. Write a prompt file outside the input directories. Include the expected behavior, allowed changes, and verification commands using the [task format](references/task-format.md).
3. Use Igor v0.1.4 or later. Check `igor doctor --model inkling-mini --json` or substitute the user's selected model. Submit `igor run --code "$code" --prompt-file "$task" --model "$model" --background --json`. Add `--docs "$docs"` when needed. Record the returned `jobId`.
4. Use `igor wait "$job_id" --json` to wait through completion. If the job failed, inspect the result and consult `igor logs "$job_id" --json` as needed before resubmitting.
5. Run `igor review "$job_id" --json` once to retrieve the result, diff, and verification summary. Review every patch hunk and any changes to tests. Use the [result format](references/result-format.md) to interpret tool evidence and the agent's report.
6. Run `igor verify "$job_id" --check "$check" --json` using a check you selected from the user's acceptance criteria. Igor applies the patch to a fresh copy of the captured snapshot and runs the check. Read its status and output. Choose independent assertions when the patch changes tests.
7. Report the job ID, observed changes, verification you personally ran, and any unresolved failures. Apply to the user's tree only after review and within the user's authorization. Recheck applicability there immediately before applying. Preserve intervening edits.
