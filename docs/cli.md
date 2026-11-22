# CLI and results

Use `igor --help` for the command grammar. `--json` emits UTF-8 JSON with `schemaVersion: 1`. Diagnostics and download progress use stderr. `logs --follow --json` emits one JSON object per line. `diff` emits the patch bytes verbatim in terminal mode. `export` creates a new file with the original patch bytes.

| Command | Result |
| --- | --- |
| `start [--model ID]` | Starts the supervisor, selects and checks the runtime and model. Repeated calls reuse a healthy matching backend. |
| `stop` | Gracefully stops Igor-owned processes. An external endpoint continues serving. |
| `status` | Returns `running`, supervisor `pid`, selected `model` and `dataDirectory`. |
| `doctor [--model ID]` | Returns `ok` and named dependency, configuration, sandbox and model checks. |
| `run` | Blocks and returns the final result. `--follow` streams progress to stderr while stdout still receives the final result. `--background` returns `jobId` immediately after the queue transaction commits. |
| `list [--status STATE]` | Returns `jobs` in submission order. |
| `status JOB_ID` | Returns timestamps, transition history, state and eventual `jobExitCode`. |
| `logs JOB_ID [--follow]` | Returns events, or streams them until completion. Job stderr is retained separately in the logs directory. |
| `wait JOB_ID`, `result JOB_ID` | Return the result and its exit code. `result` requires a terminal job. |
| `review JOB_ID --json` | Returns the original result, diff, Pi tool evidence and latest independent verification in one response. Retrieving a failed job's artifacts succeeds. |
| `verify JOB_ID --check CMD --json` | On macOS, applies the patch to a fresh copy of the original snapshot and runs the supplied shell command under Seatbelt. |
| `diff JOB_ID`, `export JOB_ID --output FILE` | Display or save the patch. Choose a fresh export path outside the original inputs and Igor's private data directory. |
| `cancel JOB_ID` | Records a cancellation request durably. Inspect the final status with `wait`. |
| `clean [--older-than-days N]` | Deletes terminal job records and artifacts meeting the age threshold. The default threshold is zero days. |

`run` requires `--code DIR` and either `--prompt TEXT` or `--prompt-file FILE`. Optional arguments include `--docs DIR`, `--model ID`, `--context TOKENS`, `--timeout-ms MS`, and `--background`. Mock jobs also accept `--mock-delay-ms MS` and `--mock-mode success|task-failure|error|timeout`. Each job's timeout starts when preparation begins.

```sh
igor run --code ./project --docs ./design --prompt-file ./task.md --background --json
igor wait JOB_ID --json
igor review JOB_ID --json
igor verify JOB_ID --check 'node --test' --json
```

## Result contract

`review` returns `result`, `diff`, and `verification`. It also returns `diffBase64` when the original patch bytes cannot be represented exactly as UTF-8. `verification.agent` is the original job's tool evidence. `verification.independent` contains the latest completed check for the current patch, or `null` if there is none. `verification.independentlyVerified` reports whether that check passed.

`verify` uses a clean copy of the captured source and documentation. It starts the supplied command in the patched source directory with network access denied and the captured documentation available read-only at `../docs`. The response includes the shell exit code as `checkExitCode` and up to the last 32,768 characters each of stdout and stderr. The temporary copy is removed after the check. A failed command makes `verify` exit with code 1. A check that runs out of time returns code 6.

Use `igor run --follow --code . --prompt "Fix the failing test"` to watch a job. You’ll see the job ID, phases, tool calls, assistant text when each turn finishes, and excerpts of shell output when commands finish. These excerpts are also saved in the local job log. For a background job, use `igor logs JOB_ID --follow`. Add `--json` to `run --follow` when you want to parse the final result from stdout.

The package includes the [versioned result JSON Schema](result.schema.json).

| Field | Interpretation |
| --- | --- |
| `jobId`, `model`, `agent`, `status`, `exitCode`, `error` | Job identity and infrastructure outcome |
| `agentCompleted`, `agentOutcome`, `summary` | Whether the harness finished and the agent's reported `success`, `failed` or `unknown` outcome |
| `completionReason`, `finalStopReason`, `agentReply` | For settled Pi jobs, the interpreted completion reason, Pi's last stop reason and the last 64,000 characters of its final visible reply |
| `verification.commands` | Observed Pi shell commands, tool success and exit code when available. A successful Bash tool call indicates exit zero. An error without a numeric code uses `null`. |
| `verification.status`, `independentlyVerified` | `tool_results` means shell results were observed. `unverified` means none were recorded. Independent verification belongs to the reviewer. |
| `baseRevision`, `filesChanged`, `artifacts` | Source revision, modified paths, patch and manifest names, and whether collection finished |
| `durationMs`, `runtime`, `resources` | Context reservations, available version/revision evidence, reported token counts and host measurements |

A completed job returns exit 0 when Pi provides a valid success report and finishes within the output budget. A reported failure, missing final report, or final stop at the output limit returns exit 1. A runtime error uses `status: "failed"` and records diagnostics. A failed job can have a usable patch. `patchComplete` describes artifact collection. Inspect the patch and use independent checks when deciding whether it meets the task.

| Exit | Meaning |
| --- | --- |
| 0 | Command succeeded |
| 1 | Execution or reported task failure |
| 2 | Invalid input, path, or configuration |
| 3 | Missing or incompatible dependency |
| 4 | Model, download or inference failure |
| 5 | Sandbox unavailable or policy probe failed |
| 6 | Job timeout |
| 7 | Cancellation |

Command-level JSON errors contain `schemaVersion`, `exitCode` and `error`. Use `status JOB_ID` to inspect a failed job with a successful lookup exit code.
