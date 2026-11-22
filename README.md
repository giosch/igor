# Igor

Igor delegates bounded coding tasks to Pi on a local Apple Silicon Mac. Give it a prompt, a source directory, and optional documentation. It copies the inputs, runs one job at a time, and returns a Git patch for review. The source tree stays in your hands.

## Run on the M5 Pro

Register Igor's Homebrew tap, then install Igor and the oMLX model server using the tap's Brewfile. Igor includes the pinned Pi harness. Download the default Inkling model once (about 16.9 GB).

```sh
brew tap giosch/igor https://github.com/giosch/igor.git
brew bundle --file="$(brew --repository giosch/igor)/Brewfile"
igor model download inkling-mini
igor doctor
igor start
```

If you already installed Igor and see `Missing executable: omlx`, run `brew update` and the Brewfile command above, then download the model. After existing jobs finish, run `igor stop` once to pick up the upgraded installation before running `igor start`. To try the offline demo with a smaller install, use `brew install giosch/igor/igor` and `igor start --model mock`.

Examples, tests, and the Claude Code skill are included under `$(brew --prefix giosch/igor/igor)/libexec`. The Mac setup guide includes the 32k and 64k hardware tests. [Mac setup and acceptance](docs/macos-setup.md)

## Try a job on Windows or macOS

Install Node.js 24 LTS and Git. Run these commands in the project directory. The mock backend works offline and produces a deterministic file change.

```powershell
npm install
npm test
npm link
igor doctor --model mock
igor start --model mock
igor model list
igor run --prompt-file ./examples/task.md --code ./examples/sample-project --model mock --follow --json
```

Use `--follow` to watch tool activity as it happens. Progress uses stderr and the final JSON result uses stdout. Copy the returned job ID into the following commands. Export to a new file outside the submitted project.

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

Once `igor doctor` passes on your Mac, install the Igor plugin from this repository using Claude Code:

```sh
claude plugin marketplace add giosch/igor
claude plugin install igor@igor-tools
```

In Claude Code, run `/igor:igor-delegate Fix the failing test and show me the patch for review.` The plugin uses the `igor` CLI on your PATH. To install the skill manually, copy `skills/igor-delegate` into `.claude/skills/` in your project or `~/.claude/skills/` for personal use, then invoke `/igor-delegate`. [Delegation skill](skills/igor-delegate/SKILL.md)

## What the tests cover

`npm test` uses temporary directories and a local scripted HTTP provider. It exercises SQLite concurrency and recovery, subprocess ownership, Git patch application, exact file contents, path safety, model downloads, and the gateway. If Pi 1.6.0 is installed, the suite also drives its actual RPC process through read, write and shell calls. Set `IGOR_TEST_PI` to its absolute `dist/bundle/cli.js` when it is unavailable on PATH. Set `IGOR_REQUIRE_PI=1` to make a missing Pi fail the suite.

The native Seatbelt test runs on macOS. The hardware acceptance command uses the real model and saves its measurements and reviewed patch under the Igor data directory. The Windows development backend accepts only the built-in mock agent. The Windows Pi integration test uses a disposable fixture and a provider with three fixed tool instructions.

## Reference

- [CLI and JSON contracts](docs/cli.md)
- [Supervisor, snapshots and recovery](docs/architecture.md)
- [Model registry and downloads](docs/models.md)
- [Sandbox, filesystem policy and operational limits](docs/security.md)
- [Mac setup, hardware acceptance and Claude Code smoke test](docs/macos-setup.md)
