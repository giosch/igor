# Execution and filesystem policy

Real Pi jobs require Apple's `/usr/bin/sandbox-exec`. The adapter constructs a deny-by-default Seatbelt profile and probes that exact profile before starting Pi. A policy compilation, access, network or subprocess probe failure terminates the job with code 5. Seatbelt is deprecated and its behavior is release-specific. Run the native acceptance suite after changing macOS, Node, Pi, the runtime, or the installation layout.

| Resource | Worker access |
| --- | --- |
| Copied code | Read and write |
| Copied documentation | Read |
| Per-job scratch, temporary files and Pi config | Read and write |
| Node, Pi, system libraries and toolchain paths in the profile | Read and execute |
| Inference | One loopback gateway port with a random job token |
| Other jobs, job controls, original sources, normal home and weight cache | Denied by the profile |

Pi starts offline with a fresh HOME, agent directory and ephemeral session. Explicit flags disable project approval, extensions, MCP, skills, themes, prompt templates and automatic context loading. The environment is constructed from scratch. The gateway creates fresh upstream headers, fixes the model, reconstructs the chat payload, accepts text and ordinary function tools, and restricts HTTP routes. The worker receives a short-lived gateway token. Upstream credentials stay in the supervisor.

The job preflight exercises writable code and scratch, read-only documentation, a protected host sentinel, a symlink to the sentinel, an actual child process, and the worker environment. It checks a live approved port, a separate listening port, and a reserved non-loopback address. The macOS test suite also verifies sibling job and unrelated host-file denial. The Windows development adapter runs only deterministic mock operations. A VM would be appropriate for stronger adversarial isolation.

## Snapshot policy

When the selected documentation directory is inside the source tree, Igor puts it in `workspace/docs` and reserves its original subtree from patch collection. This keeps the selected documentation out of the writable code copy.

Git sources include tracked files at their current working bytes and untracked files selected by `git ls-files --others --exclude-standard`. The manifest records tracked files currently missing. Plain directories use recursive enumeration. Submodules and conflicted entries require separate selection or resolution. A selected directory link is canonicalized as the user's chosen root. Links and junctions encountered inside the selected root fail the job, including links in tracked ancestors. Materialize required links into an ordinary input copy.

Igor prunes Git metadata, dependency/build caches, local agent configuration, common credential files and directories, and names such as `.env`, `.env.*`, `.npmrc`, SSH keys, and private-key containers. The explicit list lives in `src/workspace/snapshot.js`. The snapshot manifest records exclusions encountered during enumeration. Git-ignored untracked paths are omitted by Git before enumeration. Source and data directories must be disjoint. Nonportable names, path traversal and special files are rejected. Size/count limits produce a path-specific error. Defaults are 20,000 files, 32 MiB per file and 512 MiB per input tree. Change `config.json` to size these for your project.

The collector checks output paths, rejects links, and computes a raw-byte Git tree using private metadata. Each exported patch needs review against the manifest and the current source. Out-of-band changes to a source tree during capture can invalidate a snapshot. Treat the host account, configured runtime binaries, and Igor's data directory as trusted. The file exclusion list is a naming policy and cannot identify every secret embedded in source. Snapshot and output limits do not impose hard GPU, CPU, or disk quotas during agent execution.
