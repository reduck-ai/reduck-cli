import type { CommandOptions } from "commander";

/**
 * Visibility for commands behind a per-account feature flag, and nothing more: the server decides
 * whether the account may use a command.
 *
 * The switch is an env var and not the account's actual flags because `--help` renders before any
 * network call.
 */

/**
 * Command options that keep a command out of the parent's `--help` until REDUCK_EXPERIMENTAL is set:
 * `program.command("thing", experimental())`. A hidden command runs when typed.
 *
 * Pass it to the group rather than to each subcommand — hiding the parent hides the branch.
 */
export function experimental(): CommandOptions {
	return { hidden: !process.env.REDUCK_EXPERIMENTAL?.trim() };
}
