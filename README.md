<p align="center">
  <img src="https://cdn.reduck.ai/logo-full-dark.png" alt="Reduck" width="300" />
</p>

# Reduck CLI

[![npm]](https://www.npmjs.com/package/@reduck-ai/cli) ![](https://img.shields.io/badge/Node.js-22%2B-brightgreen?style=flat-square)

[npm]: https://img.shields.io/npm/v/@reduck-ai/cli.svg?style=flat-square

Reduck CLI is a command-line tool that connects your browser to [Reduck](https://reduck.ai) and lets you discover, run, and chain saved browser automation scripts, all from your terminal.

## Get started

1. Authenticate:

    ```bash
    npx @reduck-ai/cli@latest login
    ```

2. Run a script:

    ```bash
    npx @reduck-ai/cli@latest run --script linkedin.com/get_profile_info username=williamhgates
    ```

## Authentication

`npx @reduck-ai/cli@latest login` runs an OAuth2 PKCE flow against the authorization server the MCP advertises, requesting a token scoped to the MCP. Credentials are stored in `~/.config/reduck/config.json` (mode `0600`) and refreshed automatically; `logout` clears them.

You can also authenticate with an API key by setting `REDUCK_API_KEY`.

## Reference

The commands, as `--help` prints them.

### All commands

<!-- from: npx @reduck-ai/cli@latest --help -->

```text
Usage: npx @reduck-ai/cli@latest [options] [command]

Run Reduck scripts against your browser, via the Reduck MCP.

Options:
  -V, --version               output the version number
  -h, --help                  display help for command

Commands:
  login                       Authenticate against the Reduck MCP (OAuth2 PKCE).
  logout                      Revoke and remove saved credentials for the active
                              MCP target.
  list|ls [options] [handle]  List scripts. Without a handle, searches across
                              your own, your projects', and the official
                              scripts. With a handle, scopes to that owner.
  read [options] <script>     Read a saved script's contract (loggedIn +
                              input/output JSON Schemas) via the MCP's
                              read_script — the arg names to pass to `run`.
  skill [name]                Print Reduck skill docs to stdout. Public: you do
                              not need to sign in.
  whoami                      Show which Reduck account the CLI is authenticated
                              as.
  run [options]               Run one or more saved scripts via the MCP's
                              run_script — on your browser, via the paired
                              extension. Repeat --script to run several at once,
                              each on its own browser.
  help [command]              display help for command

Some commands are experimental and hidden from this list. Set REDUCK_EXPERIMENTAL=1 to show them.
```

<!-- /from -->

### `list`

<!-- from: npx @reduck-ai/cli@latest list --help -->

```text
Usage: npx @reduck-ai/cli@latest list|ls [options] [handle]

List scripts. Without a handle, searches across your own, your projects', and
the official scripts. With a handle, scopes to that owner.

Arguments:
  handle                     Optional owner scope: "@user" (with @) for a user,
                             or a project handle (without @), e.g. "reduck" for
                             the official scripts. Omit for a cross-owner
                             search.

Options:
  -q, --query <q>            Search across name, slug, host, description and the
                             input/output schemas. Ranks by relevance.
  --host <host>              Filter by host (e.g. linkedin.com).
  --visibility <visibility>  Visibility filter: "public" or "private". Omit to
                             show both. (choices: "public", "private")
  --archived <filter>        Archive filter: "exclude" (default) hides archived,
                             "only" shows archived exclusively, "include" shows
                             both. (choices: "exclude", "include", "only",
                             default: "exclude")
  -h, --help                 display help for command

Examples:
  $ npx @reduck-ai/cli@latest list
  $ npx @reduck-ai/cli@latest list -q linkedin
  $ npx @reduck-ai/cli@latest list reduck
  $ npx @reduck-ai/cli@latest list @myhandle -q scrape
  $ npx @reduck-ai/cli@latest list myproject --host linkedin.com
```

<!-- /from -->

### `read`

<!-- from: npx @reduck-ai/cli@latest read --help -->

```text
Usage: npx @reduck-ai/cli@latest read [options] <script>

Read a saved script's contract (loggedIn + input/output JSON Schemas) via the
MCP's read_script — the arg names to pass to `run`.

Arguments:
  script             Script address as printed by `list`:
                     [<handle>/]<host>/<slug>. Bare host/slug = your own; a
                     handle prefix (@user or a project like reduck for the
                     official scripts) = that owner's public script.

Options:
  --code             Also print the raw script body (the contract — description,
                     loggedIn, input/output schemas — is always shown).
  --version-id <id>  Read a specific version instead of the current one (from
                     list_script_versions).
  -h, --help         display help for command

Examples:
  $ npx @reduck-ai/cli@latest read news.ycombinator.com/top
  $ npx @reduck-ai/cli@latest read reduck/linkedin.com/get_post --code
```

<!-- /from -->

### `run`

<!-- from: npx @reduck-ai/cli@latest run --help -->

```text
Usage: npx @reduck-ai/cli@latest run [options]

Run one or more saved scripts via the MCP's run_script — on your browser, via
the paired extension. Repeat --script to run several at once, each on its own
browser.

Options:
  --script <addr...>  A script to run: its address ([<handle>/]<host>/<slug>)
                      followed by its key=value args, e.g. `--script
                      linkedin.com/get_post url=… max=5`. Bare addr = your own;
                      a handle prefix (@user, or a project like reduck for the
                      official scripts) = that owner's public script. Arg values
                      are coerced to the script's type: plain `siret=913…` stays
                      a string, pass JSON for arrays/objects (`ids=[1,2]`). Bind
                      a file input with `file:<input>=<path>` (e.g.
                      `file:attachment=./banner.png`). The file is uploaded with
                      the run, and the page gets it under the input's name, so
                      pass the script's own name input if it has one
                      (send_email: attachmentName). Repeat --script to run
                      several at once, each on its own browser (see --sequential
                      to chain them instead). (default: [])
  --sequential        Chain the --script list through ONE browser, in order,
                      instead of running them at once: each script inherits the
                      previous one's cookies, page and navigation (not its
                      result). Stops at the first failure. Use it when a script
                      needs the state another leaves behind (sign in, then act).
  --device <id>       Target a specific registered device (id from
                      `list_devices`) instead of auto-picking the paired
                      extension.
  --out <dir>         Directory to deliver downloaded files into, under their
                      real names (default: ~/Downloads).
  --version-id <id>   Run a specific version instead of the current one (from
                      list_script_versions). Only for single-script runs.
  -h, --help          display help for command

Runs on your browser via the paired extension — the MCP auto-picks it,
or pass --device <id> (see list_devices) to choose. Prints the script's result as
JSON on stdout (pipe it to jq); the run's step trace is read separately, through the
MCP's read_run_trace({runId}).
Repeat --script to run several at once, each on its own browser — stdout is then a
JSON array, one result per script, in the order given, and one failing does not stop
the others. Add --sequential to chain them through one browser instead (in order,
stopping at the first failure — the rest then report that they never ran, so the array
still has one entry per script). Exit code 0 iff every script succeeded. Set
REDUCK_MCP_URL to use another MCP server, and run
`npx @reduck-ai/cli@latest login` once per server.

Examples:
  $ npx @reduck-ai/cli@latest run --script linkedin.com/get_profile_info username=williamhgates
  $ npx @reduck-ai/cli@latest run --script reduck/linkedin.com/get_post url=…   # official scripts
  $ npx @reduck-ai/cli@latest run --script news.ycombinator.com/top --device 4f3c…   # a specific device
  $ npx @reduck-ai/cli@latest run --script reduck/mail.google.com/send_email to=me@example.com subject=Hi attachmentName=banner.png file:attachment=./banner.png   # file input
  $ npx @reduck-ai/cli@latest run --script site.com/a --script site.com/b   # both at once, a browser each
  $ npx @reduck-ai/cli@latest run --sequential --script site.com/login --script site.com/scrape max=5   # chain, one browser
  $ REDUCK_MCP_URL=https://mcp.example.com npx @reduck-ai/cli@latest run --script example.com/title
```

<!-- /from -->

## Experimental features

Features in early access are enabled per account. Their commands are hidden from `--help` unless
`REDUCK_EXPERIMENTAL=1` is set, and still work when invoked directly.

A command belonging to a feature your account is not enabled for returns `403`. Request early
access at https://form.reduck.ai or contact Reduck at contact@reduck.ai

## Reporting bugs

Reach out on [Discord](https://discord.com/invite/MPBQWCVTAq).

## License

MIT
