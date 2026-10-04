# Third-Party Notices

This package, `@8kugames/dsh-zed-acp`, derives from software developed by
third parties. Their copyright and license terms are acknowledged below.

## Derived work: deepseek-harness

The Zed-oriented ACP server in `src/` is a derivative of the
[`deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)
`packages/acp` server and its supporting packages. The agent-preset
declarations in `presets/` are copied verbatim from the same repository's
`packages/bundle/web-app/presets/`.

- Copyright (c) 2026 DeepSeek
- Licensed under the MIT License; see [`LICENSE`](./LICENSE).

## Runtime dependencies

The runtime dependencies below are resolved from the npm registry at install
time. They are not bundled into `dist/` (all packages are marked external at
build time), so the versions and licenses listed here are the ones recorded
in `package-lock.json`.

| Package                    | Version    | License    |
| -------------------------- | ---------- | ---------- |
| `@agentclientprotocol/sdk` | 1.4.0      | Apache-2.0 |
| `@deepseek-ai/dsh-brand`   | 0.2.0-rc.2 | MIT        |
| `@deepseek-ai/schemastery` | ~3.18.4    | MIT        |
| `commander`                | ^15.0.0    | MIT        |

## Host-provided peer dependencies

The `@deepseek-ai/dsh-*` and `@deepseek-ai/cordis` peer dependencies are
optional at install time and are supplied by the dsh profile runtime that
loads this plugin. They are MIT-licensed, Copyright (c) 2026 DeepSeek.
