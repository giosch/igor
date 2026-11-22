# Run Igor on Apple Silicon

Use a native arm64 terminal on the Mac. The target is an M5 Pro with 48 GB of unified memory. The pinned checkpoint contains about 16.9 GB of model data. Allow additional disk space for partial downloads, job copies and runtime caches. The 32k and 64k memory measurements come from the acceptance run on your own machine.

## Install Igor with Homebrew

If the `brew` command is new to this machine, install Homebrew first and follow its printed shell setup instructions. A tap is a repository of installation recipes. Igor's Brewfile installs Igor, its pinned Pi harness, Node 24, Git and the upstream oMLX CLI. [Homebrew](https://brew.sh/)

```sh
brew tap giosch/igor https://github.com/giosch/igor.git
brew bundle --file="$(brew --repository giosch/igor)/Brewfile"
omlx --version
igor model download inkling-mini
igor doctor
igor start
```

For a smaller offline demo, use `brew install giosch/igor/igor` and `igor start --model mock`. Check for updates with `brew update` followed by `brew upgrade giosch/igor/igor`. After active jobs finish, run `igor stop` and `igor start` to use an upgraded supervisor.

## If start reports a missing oMLX executable

The executable name is `omlx`. You can add it to an existing Igor installation using the upstream tap. Igor starts its own `omlx serve` process. [oMLX installation](https://github.com/jundot/omlx#install)

```sh
brew tap jundot/omlx https://github.com/jundot/omlx
brew install jundot/omlx/omlx
omlx --version
```

If `omlx --version` succeeds and Igor reports a different executable name, check `omlxPath` in `~/Library/Application Support/igor/config.json`. Its default is `"omlx"`. For a custom installation use the absolute path printed by `command -v omlx`. After existing jobs finish, run `igor stop` and `igor start` to reload the configuration. A first launch also requires the weights from `igor model download inkling-mini`.

## Verify the installation on your hardware

If Igor reports `Installed runtime lacks --pin`, upgrade Igor to v0.1.2 or newer with `brew update` and `brew upgrade giosch/igor/igor`. Run `igor stop` after any active jobs finish, then `igor start` to pick up the fix. Your existing oMLX installation and model cache carry over.

The Homebrew installation includes the examples and acceptance suite.

```sh
export PATH="$(brew --prefix node@24)/bin:$PATH"
cd "$(brew --prefix giosch/igor/igor)/libexec"
npm run test:mac
```

For a source checkout or unpacked npm release, install oMLX with the upstream commands above and Pi with `npm install -g @earendil-works/pi-coding-agent@1.6.0`. Run `npm install` and `npm link` from the source root, then use that directory in place of Homebrew's `libexec`.

`test:mac` creates a disposable project and saves a report and reviewed patch under `~/Library/Application Support/igor/acceptance/`. It checks, in order,

1. Dependency versions, installed model files, and Seatbelt availability.
2. A native policy probe and real Pi tool calls against an offline scripted provider.
3. Full weight checksums and oMLX readiness with the expected model ID.
4. A failing clamp fixture, a real Inkling coding job, its observed `node --test` command, patch applicability, and five independent clamp assertions in a fresh sandbox.
5. An oMLX log entry confirming active bundled DSpark or Lightning MTP.
6. A long prompt at the 32,768-token configuration, its returned marker, observed provider input tokens, and process-memory samples.

After the 32k run succeeds, use `npm run test:mac -- --64k` to exercise 65,536. Output tokens are reserved inside the context window. The report records actual input tokens for each run. Descendant RSS is sampled once per second and can count shared pages more than once. System free bytes and process RSS are available for comparison across runs. They do not measure MLX GPU allocations directly.

## First real job

### Compare Inkling reasoning settings

Use Igor 0.1.5 or later. After active jobs finish, run `igor stop` so the next job uses the upgraded supervisor. Supply the original project, prompt file, and an independent check that fails on the original fixture:

```sh
export PATH="$(brew --prefix node@24)/bin:$PATH"
node "$(brew --prefix giosch/igor/igor)/libexec/scripts/benchmark-inkling.js" \
  --code /path/to/original-project --prompt-file /path/to/original-task.md \
  --check 'node --test'
```

Add `--docs DIR` and `--context TOKENS` if the original run used them. The script runs one job each for `default`, `none`, and `low` using the same managed oMLX runtime and output budget. It checks snapshot digests and writes a report with job IDs, timings, token counts, changed files, and independent verification results. Each trial's review JSON includes its diff. `patchPass` requires both a changed file and a passing check. Because the first trial can load the model and later trials can benefit from cache state, treat the three timings as a smoke comparison.

### Run a coding task

```sh
igor start --model inkling-mini
igor run --code ./examples/sample-project --prompt-file ./examples/task.md --json
igor result JOB_ID --json
igor diff JOB_ID
igor stop
```

Jobs use the detached supervisor and survive terminal closure. The supervisor selects the model specified by each job. `start --model` warms that selection for reuse. A nonstandard install can set `piPath` to the absolute npm-installed `dist/bundle/cli.js` and `omlxPath` to the absolute CLI executable in `config.json`. `igor status --json` prints the data path. `IGOR_HOME` selects a separate dedicated directory.

If Seatbelt rejects a job, inspect `jobs/JOB_ID/logs/stderr.log` and `input/seatbelt.sb`. For runtime problems, inspect `runtime/inkling-mini/server.log`. For loading or tool-call incompatibilities, retain the report, exact versions, and model revision. A missing MTP log marker leaves that acceptance check failed so the runtime evidence can be inspected.

## Optional login supervision

The default detached process starts on demand. For login startup and automatic recovery while logged in, a user LaunchAgent can run `node /absolute/path/to/igor/src/cli/index.js supervise` as its foreground process. Use absolute paths for Node and the installed CLI in `ProgramArguments`, a user-specific `Label`, `RunAtLoad`, and `KeepAlive` with `SuccessfulExit` set to false. Supply PATH with the installed Git, Node, Pi and oMLX binaries through `EnvironmentVariables`. Stop the on-demand supervisor before bootstrapping the LaunchAgent. Both entry points use the same exclusive ownership lock and SQLite recovery. [Apple's launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

## Claude Code acceptance

Register the marketplace and install the Claude Code plugin once:

```sh
claude plugin marketplace add giosch/igor
claude plugin install igor@igor-tools
```

From the Igor repository root or the Homebrew `libexec` directory, create a disposable project:

```sh
review_project="$(mktemp -d)"
cp -R examples/sample-project/. "$review_project/"
cd "$review_project"
git init -q
claude
```

Invoke `/igor:igor-delegate Fix clamp.js so both bounds work. Use the inkling-mini model, preserve the existing test, and show me the reviewed patch before applying it.` Check that Claude uses `igor review` to retrieve the patch and `igor verify` to run an independent check in a disposable copy. The original fixture should still fail its upper-bound assertion at the review point. Approve application in this disposable project, then run `node --test` and inspect `git diff --no-index /dev/null clamp.js` or the file itself. This step uses your signed-in Claude Code installation. [Claude Code skills](https://code.claude.com/docs/en/skills)
