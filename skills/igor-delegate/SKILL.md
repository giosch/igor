---
name: igor-delegate
description: Delegate a bounded, independently verifiable coding task to a local Igor worker, track it, and review its Git patch.
---

# Delegate a coding task to Igor

Choose a task with a small source boundary and a concrete verification command. Consult [delegation policy](references/delegation-policy.md) before selecting inputs. The worker receives a copy of the current files, including local edits selected by Igor's snapshot policy.

1. Locate the source root containing every file needed for the task. Select a separate documentation directory when the worker needs reference material. Read the relevant tests and define observable acceptance criteria.
2. Write a prompt file outside the input directories. Include the expected behavior, allowed changes, and verification commands using the [task format](references/task-format.md).
3. Check `igor doctor --model inkling-mini --json` or substitute the user's selected model. Submit `igor run --code "$code" --prompt-file "$task" --model "$model" --background --json`. Add `--docs "$docs"` when needed. Record the returned `jobId`.
4. Use `igor status "$job_id" --json` and `igor logs "$job_id" --follow --json` to observe progress. Use `igor wait "$job_id" --json` to wait through completion. Read diagnostics from a failed job before considering another submission.
5. Retrieve `igor result "$job_id" --json` and `igor diff "$job_id"`. Review the changed-file manifest, tests, and every patch hunk. Use the [result format](references/result-format.md) to interpret tool evidence and the agent's report.
6. Export with `igor export "$job_id" --output "$patch"` to a fresh path outside the sources. Make a disposable review copy matching the captured working tree, including dirty and selected untracked files. Run `git apply --check "$patch"` from that copy. Apply the reviewed patch there and run independent acceptance checks with suitable isolation.
7. Report the job ID, observed changes, verification you personally ran, and any unresolved failures. Apply to the user's tree only after review and within the user's authorization. Recheck applicability there immediately before applying. Preserve intervening edits.
