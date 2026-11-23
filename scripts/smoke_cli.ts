// Live CLI smoke through the built binary, with your own account:
// whoami, then list (the probe is listed), then run the probe.
//
//   pnpm build && node dist/index.js login
//   PROBE=<host>/<slug> EXPECT=<substring> pnpm smoke:cli
//   REDUCK_MCP_URL=<mcp-url> PROBE=... EXPECT=... pnpm smoke:cli
//
// PROBE is required: [<handle>/]<host>/<slug> of a script your account can list and run, ideally one whose
// output does not depend on a website changing. EXPECT is a substring of its
// output (default "1"). A failure then points at the pipe (token, MCP,
// browser, validation) and not at the website.
//
// The run uses your default browser: a paired device, or a cloud browser.
// Read-only against your credentials: it never logs out and never forces a
// refresh, because a rotation could invalidate the stored refresh token.
// REDUCK_CONFIG passes through to the spawned binary, to test as another
// identity.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const run = promisify(execFile);
const BIN = join(import.meta.dirname, "..", "dist", "index.js");

const MCP_URL = process.env.REDUCK_MCP_URL ?? "https://mcp.reduck.ai";
const PROBE = process.env.PROBE?.trim();
if (!PROBE)
	throw new Error(
		"Set PROBE=<host>/<slug> to a script your account can run, and EXPECT to a part of its output."
	);
const EXPECT = process.env.EXPECT ?? "1";

function expect(label: string, cond: boolean): void {
	if (!cond) throw new Error(`FAIL: ${label}`);
	console.log(`  ok: ${label}`);
}

async function cli(args: string[]): Promise<{ out: string; code: number }> {
	try {
		const { stdout, stderr } = await run("node", [BIN, ...args], {
			env: { ...process.env, REDUCK_MCP_URL: MCP_URL }
		});
		return { out: stdout + stderr, code: 0 };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; code?: number };
		return { out: (err.stdout ?? "") + (err.stderr ?? ""), code: err.code ?? 1 };
	}
}

console.log(`target: ${MCP_URL}  probe: ${PROBE}`);

console.log(
	"1. GIVEN a one-time login for this origin  WHEN whoami runs  THEN the stored token authenticates you (refreshing silently if stale)"
);
const who = await cli(["whoami"]);
if (who.out.includes("Not authenticated"))
	throw new Error(
		`No token for ${MCP_URL}. Run: REDUCK_MCP_URL=${MCP_URL} node dist/index.js login`
	);
expect("whoami succeeds", who.code === 0 && who.out.includes("—"));

console.log(
	"2. GIVEN the probe exists  WHEN list runs  THEN it appears"
);
// PROBE is [<handle>/]<host>/<slug>, as `list` prints it.
const parts = PROBE.split("/");
const probeHost = parts[parts.length - 2];
const probeHandle = parts.length > 2 ? [parts[0]] : [];
const list = await cli(["list", ...probeHandle, "--host", probeHost]);
expect(`list shows ${PROBE}`, list.code === 0 && list.out.includes(PROBE));

console.log(
	"3. GIVEN the probe  WHEN run executes it  THEN EXPECT lands on stdout, exit 0"
);
const r = await cli(["run", "--script", PROBE]);
expect(`run exits 0`, r.code === 0);
expect(`output contains ${JSON.stringify(EXPECT)}`, r.out.includes(EXPECT));

console.log(`PASS: CLI end-to-end green against ${MCP_URL}`);
