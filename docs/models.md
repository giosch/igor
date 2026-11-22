# Models and inference

Igor creates `models.json` on first use. The shipped Inkling definition pins `mlx-community/Inkling-2-Mini-oQ4e-mtp` at `3eea042751cd296b7266628a8342c1749242e1fe`. That revision contains 13 selected data files totaling 16,873,807,686 bytes, including the bundled DSpark draft. The registry starts with a 32,768-token budget, an 8,192-token output reservation, and a 65,536-token runtime cap. The model card identifies oMLX 0.8.1 as the minimum. [Checkpoint and model card](https://huggingface.co/mlx-community/Inkling-2-Mini-oQ4e-mtp/tree/3eea042751cd296b7266628a8342c1749242e1fe)

```sh
igor model list --json
igor model inspect inkling-mini --json
igor model download inkling-mini
igor model verify inkling-mini
igor model add my-local --file my-local.json
igor model remove my-local
```

`add` only registers a definition. `download` resolves an optional floating revision once, fetches files at the immutable commit, resumes partial responses, and checks each file's LFS SHA-256 or Git blob SHA-1. A completed manifest and current-revision pointer are atomically published. `verify` rehashes the cached files. Startup checks the selected revision, file inventory and sizes. oMLX uses a private base directory, loopback binding, a per-start API key, pinned weights and per-model MTP/context settings. The runtime log is at `runtime/MODEL_ID/server.log`. The adapter checks the installed version and available flags before launch. [oMLX launch interface](https://github.com/jundot/omlx/blob/v0.8.2/omlx/cli.py)

| Runtime | Format | Source |
| --- | --- | --- |
| `mock` | `mock` | Built-in deterministic worker and tiny verifiable download |
| `omlx` | `mlx` | Hugging Face data-only MLX safetensors directory |
| `llamacpp` | `gguf` | Hugging Face repository with one explicit GGUF file, loaded by `llama-server` |
| `external` | `api` | User-managed OpenAI-compatible `/v1` endpoint |

For a GGUF entry set `source.type` to `huggingface` and supply `repository`, `revision` and `file`. For example, start from the shipped definition, set `runtime` to `llamacpp`, `format` to `gguf`, and set `options` to an object containing your `modelId`. Use limits, quantization and tool capability appropriate to that GGUF. Managed llama.cpp uses a single context slot and its Jinja tool template. [llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)

An external entry can use the following shape. Set the model ID and limits to match your server.

```json
{
  "runtime": "external",
  "source": { "type": "external" },
  "format": "api",
  "quantization": "server-managed",
  "context": { "modelMaximum": 32768, "runtimeMaximum": 32768, "default": 16384 },
  "generation": { "maxOutputTokens": 2048, "temperature": 0.2 },
  "capabilities": { "tools": true, "vision": false },
  "options": { "modelId": "my-tool-model", "endpoint": "http://127.0.0.1:8000/v1" }
}
```

For an authenticated server set `options.apiKeyEnv` to the name of a host environment variable. Start the supervisor from an environment containing the key. Remote endpoints require HTTPS and receive the task content. The gateway forwards only text chat and the four allowed function tools. Model availability is checked against `/v1/models`. Actual tool use is exercised separately by the Pi integration and Mac acceptance tests.

The effective context is the minimum of the model maximum, runtime maximum, and job request. The default request is the registry's `context.default`. Igor passes the effective limit and output maximum to Pi and configures compaction to reserve the output budget. The gateway caps generated tokens and enforces the registry temperature. Each job checks Pi's selected provider, model and context using RPC state. [Pi model configuration](https://github.com/earendil-works/pi/blob/v1.6.0/packages/coding-agent/docs/models.md)
