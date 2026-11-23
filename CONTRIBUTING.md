# Contributing

## Setup

```bash
pnpm install
pnpm build    # bundles src/ into dist/index.js
pnpm check    # type check, and README.md against the output of --help
pnpm test     # unit tests
node dist/index.js --help
```

The flock tests build apps against the flock page runtime. They download it once
from `https://flock.reduck.ai/client/` into `tests/.runtime/`. Set
`FLOCK_RUNTIME_DIR` to use a folder that holds the runtime, or
`REDUCK_FLOCK_URL` to download it from another host.

## Environment variables

| Variable             | Default                  | Use                                       |
| -------------------- | ------------------------ | ----------------------------------------- |
| `REDUCK_API_KEY`     | none                     | Authenticate with an API key, not OAuth.  |
| `REDUCK_MCP_URL`     | `https://mcp.reduck.ai`  | The Reduck MCP that the commands call.    |
| `REDUCK_APP_URL`     | `https://reduck.ai`      | The Reduck API.                           |
| `REDUCK_FLOCK_URL`   | `https://flock.reduck.ai`| The flock host.                           |
| `REDUCK_CONFIG`      | `~/.config/reduck/config.json` | Where the credentials are kept.     |
| `REDUCK_EXPERIMENTAL`| none                     | `1` shows the experimental commands.      |
| `REDUCK_EXTRA_HEADERS` | none                   | A JSON object of headers to send with each request. |
| `REDUCK_EXTRA_AUTH_PARAMS` | none               | A JSON object of query parameters to add to the sign-in URL. |

## README.md

The blocks of README.md that show a command's output are generated. After a
change to a command's help, run `pnpm readme`.

## Live smokes

`smoke:auth` is offline: it uses a temporary config file and never touches
yours. `smoke:cli` calls the real MCP with your own account, so build and sign
in first:

```bash
pnpm build
node dist/index.js login
```

`smoke:cli` runs `whoami`, `list` and `run` through the built binary. It needs
a script that your account can list and run, given as `PROBE`. Pick a script
with a stable output and give a part of that output as `EXPECT`:

```bash
pnpm smoke:auth
PROBE=<host>/<slug> EXPECT=<substring> pnpm smoke:cli
```

The run uses your default browser, so a paired device or a cloud browser must
be available to your account. Set `REDUCK_MCP_URL` to test another MCP server.

## Releases

Each merge into `main` that changes the package runs **Publish**, which
publishes a patch of the version that npm holds. For a minor or a major
version, run **Publish** by hand and choose the increment. The version is not
committed: npm and the tag `v<version>` hold it.
