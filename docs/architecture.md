# Architecture

The CLI stores a versioned job specification in SQLite and starts a detached supervisor on demand. Every job carries its model definition, original input paths, prompt, requested context and timeout. The supervisor captures source bytes when the job enters preparation. If you submit background jobs against a changing tree, the snapshot manifest identifies the precise bytes used.

```text
CLI / Claude Code
       │
       ├─ SQLite FIFO ─ supervisor ─ snapshot and private Git object database
       │                     │
       │                     ├─ Seatbelt ─ Pi RPC ─ authenticated gateway ─ inference
       │                     │
       └─ status / logs / result / diff ◀─ result collector
```

The SQLite database uses WAL, full synchronous writes, and immediate transactions. A separate SQLite exclusive lock elects the supervisor. The OS releases it on termination. A unique partial index and transactional FIFO claim permit one active job. Service stop requests travel through the database. Managed children have an IPC guardian that terminates their process group on macOS if their supervisor disappears. Externally managed endpoints have no owned process.

Jobs progress through `queued → preparing → running → finalizing → completed`. Errors produce `failed`, a deadline produces `timed_out`, cancellation produces `cancelled`, and abandoned active jobs become `interrupted`. Stopping the supervisor interrupts active work and leaves queued jobs durable. The next start, submission, wait, or log-follow operation can restart the worker. It reconciles a published result if a crash occurred between the artifact rename and the terminal database commit. Other abandoned work is retained for inspection. Submitting a new job is an explicit retry.

## Artifacts

```text
IGOR_HOME/
  config.json                 Host settings and limits
  models.json                 Registry and platform default
  jobs.db                     Queue, transitions, service ownership
  cache/                      Verified weight revisions
  runtime/                    Locks, supervisor log, owned inference logs
  jobs/JOB_ID/
    input/{prompt.md,job.json,snapshot.json,baseline.git/}
    input/seatbelt.sb         Exact profile used for a real job
    workspace/{code/,docs/}
    scratch/                  Private HOME, temporary files, Pi configuration
    logs/{events.jsonl,stderr.log}
    output/{result.json,manifest.json,changes.patch}
```

Control artifacts and the baseline sit outside the worker's writable paths. The snapshot manifest records Git HEAD when available, file sizes, modes, hashes, policy exclusions and working-tree deletions. Git plumbing builds trees from raw file bytes. Binary diffs, Git rename detection, mode changes, and dirty working trees are supported. Git patches are relative to the selected code directory, including when it is a subdirectory of a larger repository.

## Implementation map

| Directory | Responsibility |
| --- | --- |
| `src/cli`, `src/config` | Argument grammar, commands, output and host configuration |
| `src/jobs`, `src/supervisor`, `src/results` | SQLite transactions, service ownership, lifecycle, metrics and result publication |
| `src/workspace` | Input inventory, copies, baseline trees and patch collection |
| `src/models`, `src/inference` | Compatibility, downloads, runtime health, server ownership and gateway |
| `src/sandbox`, `src/agents` | Development mock, native confinement and headless Pi protocol |
| `tests`, `scripts` | Portable integration tests and native acceptance runner |
| `skills/igor-delegate` | Optional Claude Code orchestration |
