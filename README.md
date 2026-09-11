# Argus-Pi

**Argus AI Team's dedicated Pi-based inference and execution harness for Argus.**

This is a maintained fork of [earendil-works/pi](https://github.com/earendil-works/pi),
not a replacement for Argus's orchestration. We optimize the Pi layer: model
requests, tool execution, context and session handling, reliability, and task
handoffs. Argus keeps ownership of goals, role authority, review and durable
mission state.

## Current downstream behavior

- The `argus` harness profile is the default: follow the assigned task and role
  instead of assuming every invocation is a coding task.
- Keep tool descriptions, Skills, project context, explicit system prompts and
  decision formats intact. The profile does not grant permissions or add a sandbox.
- Preserve the `pi` CLI, `.pi` configuration and existing provider authentication.
  `argus-pi` is an additional executable name for the same CLI. Argus-mode JSON
  output distinguishes recoverable attempt diagnostics from terminal failure,
  preserving usage and provider-turn accounting; stock, RPC and SDK retain
  upstream provider-retry event shapes.
- Local Bash uses `pipefail` so failed experiments, compilers or proof checkers
  remain failures when their output is piped through `tee`. This does not enable
  `set -e`, retry commands, or change custom remote operations or PowerShell.
- Signal-terminated commands retain partial output and an observable signal.
  A missing exit code is not treated as success. User/RPC shell records preserve
  this status in session history, model context, terminal display and HTML export.
- Set `PI_HARNESS_PROFILE=stock` to restore the upstream default system prompt
  and local Bash pipeline behavior. Both profiles report terminal text/JSON
  failures with a nonzero exit status.
- The existing `read` tool extracts page-marked PDF text, including in read-only
  review sessions. It needs no shell permission or external PDF executable.
  Use `pages: "3"` or `pages: "3-5"` to extract just the relevant pages of a long
  paper; `offset` and `limit` then count lines within that selection. Continuation
  notices retain the page range. Omitting `pages` preserves whole-document reading.
  Textless pages are explicitly marked; entirely textless, encrypted or malformed
  documents fail visibly. This is not OCR, figure inspection or layout validation.
  Selection skips text extraction outside the range, not file loading or document
  parsing, and does not validate unselected page content. No text cache is used.
- Notebook reads can use `cells: "3"` or `cells: "1-3"` for a source-first view
  of nbformat 4 notebooks. Start with `cells: "1"` to discover the cell count.
  The view includes saved execution counts and an output
  inventory, so long stored logs do not hide later validation code. Use
  `includeOutputs: true` for stored text/error outputs; rich MIME payloads are
  listed but not rendered. Saved outputs do not prove a fresh run or correctness.
  No code is executed or rewritten. Omit `cells` for the original raw JSON view,
  including exact editing context. `offset`/`limit` count rendered view lines;
  continuation notices retain the cell and output selection. The whole JSON file
  is still loaded and parsed; this is not a streaming JSON reader or a notebook
  execution engine.

The initial experiment changed only the default task prompt; PDF reading is the
first subsequent tool capability; local pipeline status handling now also
preserves execution failures. The Agent loop is unchanged. Small local
prompt-profile trials showed reduced input usage, but also exposed
timeouts, a provider request error, and missing persisted analysis scripts.
These are not claims of general performance superiority. Improvements must be
measured on matched tasks with failures and incomplete deliverables retained.

## Build and run from source

Node.js 22.19+ and npm are required. This fork is currently a source preview:
there is no separately published Argus-Pi npm package or binary release.
Installing `@earendil-works/pi-coding-agent` from npm installs upstream Pi,
not this fork.

```bash
git clone --branch argus https://github.com/Argus-AiTeam/Argus-Pi.git
cd Argus-Pi
npm ci --ignore-scripts
npm run hydrate:model-data
npm run build:offline
npm rebuild --workspace=@earendil-works/pi-coding-agent --ignore-scripts
./node_modules/.bin/argus-pi --help
```

For an existing Argus deployment configured to use the `pi` backend, place this
checkout's `node_modules/.bin` first on that process's `PATH`. No Argus source
change is required. Do not overwrite a working global Pi installation to try the
fork. Both executable names retain Pi's existing configuration and authentication
paths; use `PI_CODING_AGENT_DIR` when separate configuration is desired.

Use source control to update this source installation, not upstream's npm release
or `pi update --self`. The CLI package is marked private until a dedicated
publication identity and release process are established.

## Ongoing development

The downstream default branch is `argus`; `main` initially retains the forked
upstream history. Add `https://github.com/earendil-works/pi.git` as the `upstream`
remote and merge reviewed upstream changes into `argus` in explicit updates.
Do not force-reset the downstream branch to upstream.

Prioritize reproduced request failures and incomplete handoffs, then measured
context, tool-loop and startup overhead. Preserve role isolation and stopping
semantics. Each change needs a focused regression check and, for performance
claims, same-model/same-budget task comparisons including failure counts.
Do not commit credentials, private task logs, or provider authorization data.

CI also targets `argus`. Upstream contributor gates and release/catalog
publication jobs are restricted to the upstream repository; this fork does not
publish to upstream npm namespaces or infrastructure.

## Upstream Pi

The original packages, documentation and MIT attribution are retained below.

<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> The contributor approval policy below belongs to upstream Pi. Argus-Pi
> contributions target the `argus` branch; see [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi Agent Harness

This is the home of the Pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Standalone application-composition runtime for services, replicated state, RPC, and plugins |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
