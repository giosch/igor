# Run Igor on Apple Silicon

Use a native arm64 terminal on the Mac. The target is an M5 Pro with 48 GB of unified memory. The pinned checkpoint contains about 16.9 GB of model data. Allow additional disk space for partial downloads, job copies and runtime caches. The 32k and 64k memory measurements come from the acceptance run on your own machine.

## Install Igor with Homebrew

If the `brew` command is new to this machine, install [Homebrew](https://brew.sh/) first and follow its printed shell setup instructions. Run these commands once to register Igor's tap, install the CLI with Node 24 and Git, and check the offline mock backend.

```sh
brew tap giosch/igor https://github.com/giosch/igor.git
brew install giosch/igor/igor
igor doctor --model mock
```

Check for updates with `brew update` followed by `brew upgrade giosch/igor/igor`.

## Enable real coding jobs

Install the pinned Pi harness and the command-line build of oMLX. Igor starts its own foreground `omlx serve` child when a job needs it. [oMLX installation](https://github.com/jundot/omlx#install)

```sh
export PATH="$(brew --prefix node@24)/bin:$PATH"
npm install -g @earendil-works/pi-coding-agent@1.6.0
brew tap jundot/omlx https://github.com/jundot/omlx
brew install jundot/omlx/omlx
node -p 'process.version + " " + process.arch'
pi --version
omlx --version
```

The Homebrew installation includes the examples and acceptance suite. Download the weights and run the tests from the installed directory.

```sh
cd "$(brew --prefix giosch/igor/igor)/libexec"
igor model download inkling-mini
igor doctor --model inkling-mini
npm run test:mac
```

For a source checkout or the unpacked npm release, run `npm install` and `npm link` from its root and use that directory in place of Homebrew's `libexec`.

`test:mac` creates a disposable project and saves a report and reviewed patch under `~/Library/Application Support/igor/acceptance/`. It checks, in order,

1. Dependency versions, installed model files, and Seatbelt availability.
2. A native policy probe and real Pi tool calls against an offline scripted provider.
3. Full weight checksums and oMLX readiness with the expected model ID.
4. A failing clamp fixture, a real Inkling coding job, its observed `node --test` command, patch applicability, and five independent clamp assertions in a fresh sandbox.
5. An oMLX log entry confirming active bundled DSpark or Lightning MTP.
6. A long prompt at the 32,768-token configuration, its returned marker, observed provider input tokens, and process-memory samples.

After the 32k run succeeds, use `npm run test:mac -- --64k` to exercise 65,536. Output tokens are reserved inside the context window. The report records actual input tokens for each run. Descendant RSS is sampled once per second and can count shared pages more than once. System free bytes and process RSS are available for comparison across runs. They do not measure MLX GPU allocations directly.

## First real job

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

From the Igor repository root, create a disposable project with the installed skill.

```sh
review_project="$(mktemp -d)"
cp -R examples/sample-project/. "$review_project/"
mkdir -p "$review_project/.claude/skills"
cp -R skills/igor-delegate "$review_project/.claude/skills/"
cd "$review_project"
git init -q
claude
```

Invoke `/igor-delegate Fix clamp.js so both bounds work. Use the inkling-mini model, preserve the existing test, and show me the reviewed patch before applying it.` Check that Claude retrieves the job ID and result, reviews the exported patch, and independently verifies it in a disposable copy. The original fixture should still fail its upper-bound assertion at the review point. Approve application in this disposable project, then run `node --test` and inspect `git diff --no-index /dev/null clamp.js` or the file itself. This step uses your signed-in Claude Code installation. [Claude Code skills](https://code.claude.com/docs/en/skills)
