# Igor

Igor delegates bounded coding tasks to Pi on a local Apple Silicon Mac. Give it a prompt, a source directory, and optional documentation. It copies the inputs, runs one job at a time, and returns a Git patch for review. The source tree stays in your hands.

## Run on the M5 Pro

Follow the [Mac setup and acceptance guide](docs/macos-setup.md) for Node 24, Pi 1.6.0, oMLX, and the pinned Inkling checkpoint. Igor itself is executable JavaScript with zero npm runtime dependencies. A checkout or unpacked release contains the CLI, tests, examples, and Claude Code skill.

```sh
npm install
npm link
igor model download inkling-mini
igor doctor --model inkling-mini
npm run test:mac
```

The hardware acceptance run exercises the native sandbox, a real coding task, independent patch verification, MTP activation, and a measured context load at 32k. Add `-- --64k` to repeat the 32k checks and then exercise the larger budget.

## Try a job on Windows or macOS

Install Node.js 24 LTS and Git. Run these commands in the project directory. The mock backend works offline and produces a deterministic file change.

```powershell
npm install
npm test
npm link
igor doctor --model mock
igor start --model mock
igor model list
igor run --prompt-file ./examples/task.md --code ./examples/sample-project --model mock --json
```

Copy the returned job ID into the following commands. Export to a new file outside the submitted project.

```sh
igor list
igor status JOB_ID
igor logs JOB_ID
igor result JOB_ID --json
igor diff JOB_ID
igor export JOB_ID --output changes.patch
igor stop
```

On Windows, `npm.cmd` and `igor.cmd` also work in PowerShell environments that restrict script shims. On macOS the default model is `inkling-mini`. Other platforms default to `mock`. Use `--model` to select a different model for a job.

## Delegate from Claude Code

Copy `skills/igor-delegate` into `.claude/skills/` in the orchestrating project, or into `~/.claude/skills/` for personal use. Invoke `/igor-delegate` with the task. The skill covers acceptance criteria, background submission, patch review, and independent testing. [Delegation skill](skills/igor-delegate/SKILL.md)

## What the tests cover

`npm test` uses temporary directories and a local scripted HTTP provider. It exercises SQLite concurrency and recovery, subprocess ownership, Git patch application, exact file contents, path safety, model downloads, and the gateway. If Pi 1.6.0 is installed, the suite also drives its actual RPC process through read, write and shell calls. Set `IGOR_TEST_PI` to its absolute `dist/bundle/cli.js` when it is unavailable on PATH. Set `IGOR_REQUIRE_PI=1` to make a missing Pi fail the suite.

The native Seatbelt test runs on macOS. The hardware acceptance command uses the real model and saves its measurements and reviewed patch under the Igor data directory. The Windows development backend accepts only the built-in mock agent. The Windows Pi integration test uses a disposable fixture and a provider with three fixed tool instructions.

## Reference

- [CLI and JSON contracts](docs/cli.md)
- [Supervisor, snapshots and recovery](docs/architecture.md)
- [Model registry and downloads](docs/models.md)
- [Sandbox, filesystem policy and operational limits](docs/security.md)
- [Mac setup, hardware acceptance and Claude Code smoke test](docs/macos-setup.md)
