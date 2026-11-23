// Fills, or checks, the parts of README.md that are the output of a command rather than prose.
//
// A block names its source in a comment npm and the docs site never render, and holds that
// command's output in a fence:
//
//   <!-- from: npx @reduck-ai/cli@latest run --help -->
//
//   ```text
//   …
//   ```
//
//   <!-- /from -->
//
// `pnpm readme` rewrites every block from its command; `pnpm readme --check` exits non-zero and
// names each block whose text is behind. The check is part of `pnpm check`, so it runs wherever
// the type check does — CI, and before every build — and the README on npm, which docs.reduck.ai
// renders, is the CLI describing itself rather than a copy that drifted.
//
// `npx @reduck-ai/cli@latest` in a command runs `src/` through tsx, not the published package nor
// a build: the README describes the code beside it, and needs nothing built to be checked.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = path.join(root, "README.md");
const entry = path.join(root, "src", "index.ts");

const BLOCK = /<!-- from: (.+?) -->[\s\S]*?<!-- \/from -->/g;
const PUBLISHED = /^npx @reduck-ai\/cli(?:@latest)?\s+/;

// The CLI runs under THIS node with tsx as a loader, never through `pnpm exec`: a block holds what
// the command prints and nothing else. pnpm writes its own notices to stdout — an "Unsupported
// engine" warning on any Node the workspace does not pin — and they would land in the block, so
// the README would read as behind on the publish job's Node while it matched on the check's.
function output(command: string): string {
	const local = command.replace(PUBLISHED, "");
	const argv =
		local === command
			? ["sh", "-c", command]
			: [process.execPath, "--import", "tsx", entry, ...local.split(/\s+/)];
	return execFileSync(argv[0], argv.slice(1), { encoding: "utf8", cwd: root }).trimEnd();
}

const check = process.argv.includes("--check");
const before = readFileSync(readme, "utf8");
const stale: string[] = [];

const after = before.replace(BLOCK, (block, command: string) => {
	const filled = `<!-- from: ${command} -->\n\n\`\`\`text\n${output(command)}\n\`\`\`\n\n<!-- /from -->`;
	if (filled !== block) stale.push(command);
	return filled;
});

if (stale.length === 0) {
	console.log("README.md: every block matches its command.");
} else if (check) {
	console.error(
		`README.md is behind its commands. Run \`pnpm readme\` to update:\n  ${stale.join("\n  ")}`
	);
	process.exit(1);
} else {
	writeFileSync(readme, after);
	console.log(`README.md: rewrote ${stale.length} block(s):\n  ${stale.join("\n  ")}`);
}
