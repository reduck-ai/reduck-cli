// "The config file never betrays you" — hermetic smoke for the CLI's
// auth/config layer. Each scenario seeds a config shape a real user could
// have, runs the real built binary against it, and asserts the file + output
// behave. Sandboxed: HOME points at a scratch dir (your ~/.config/reduck is
// never touched) and tokens are fixture strings. `logout` attempts an RFC 7009 revocation, so
// scenarios that run it reach for the network and fall back to a warning when it is absent;
// everything asserted here holds either way.
// Run: `pnpm smoke:auth` (after `pnpm build`). Throws on first failure.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
const BIN = join(import.meta.dirname, "..", "dist", "index.js");
const PROD = "https://mcp.reduck.ai";
const OTHER = "https://mcp.example.com";

const HOME = mkdtempSync(join(tmpdir(), "reduck-smoke-"));
const CONFIG = join(HOME, ".config", "reduck", "config.json");

function expect(label: string, cond: boolean): void {
	if (!cond) throw new Error(`FAIL: ${label}`);
	console.log(`  ok: ${label}`);
}

// A fresh last_checked_at keeps the update check dormant (no network) —
// except where a seed deliberately forces it (the atomicity hammer).
function seed(config: Record<string, unknown>): void {
	mkdirSync(join(HOME, ".config", "reduck"), { recursive: true });
	writeFileSync(CONFIG, JSON.stringify({ last_checked_at: Date.now(), ...config }, null, 2));
}

const readCfg = (): Record<string, unknown> => JSON.parse(readFileSync(CONFIG, "utf8"));
const slots = (): Record<string, unknown> => (readCfg().servers ?? {}) as Record<string, unknown>;

// Did the binary go and get a token before calling the MCP? Discovery starts with an
// unauthenticated GET of the MCP endpoint — that is how RFC 9728 says to find the
// resource_metadata pointer — so "discovery ran first" means the protected-resource document was
// fetched before any JSON-RPC POST, not that it was the very first request.
const refreshedBeforeCalling = (hits: string[]): boolean => {
	const discovery = hits.findIndex((h) => h.includes("/.well-known/oauth-protected-resource"));
	const rpc = hits.findIndex((h) => h.startsWith("POST "));
	return discovery !== -1 && (rpc === -1 || discovery < rpc);
};

// Sandboxed invocation of the real binary. Never rejects — error paths are
// what we assert on.
async function cli(
	args: string[],
	env: Record<string, string> = {}
): Promise<{ out: string; code: number }> {
	try {
		const { stdout, stderr } = await run("node", [BIN, ...args], {
			env: { ...process.env, HOME, ...env }
		});
		return { out: stdout + stderr, code: 0 };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; code?: number };
		return { out: (err.stdout ?? "") + (err.stderr ?? ""), code: err.code ?? 1 };
	}
}

if (!existsSync(BIN)) throw new Error("dist/index.js not found — run `pnpm build` first");

// Access tokens are stored per RFC 8707 resource, so a fixture has to name the resource its
// token was issued for — by default the MCP origin the slot is keyed by.
const auth = (tag: string, resource: string) => ({
	client_id: `cid-${tag}`,
	refresh_token: `ref-${tag}`,
	tokens: { [resource]: { access_token: `tok-${tag}`, expires_at: Date.now() + 3_600_000 } }
});

try {
	console.log(
		"1. GIVEN a flat config from an old CLI  WHEN any command runs  THEN it reads as logged-out, never crashes"
	);
	seed({
		client_id: "DEAD",
		access_token: "DEAD",
		refresh_token: "DEAD",
		expires_at: 1,
		x_unknown: 7
	});
	const flat = await cli(["whoami"]);
	expect("flat file → 'Not authenticated'", flat.out.includes("Not authenticated"));

	console.log(
		"2. GIVEN that flat config  WHEN the first write lands  THEN dead flat keys are evicted, keys it doesn't own survive"
	);
	await cli(["logout"]);
	const healed = readCfg();
	expect("flat auth keys gone", !("client_id" in healed) && !("access_token" in healed));
	expect("unknown key preserved", healed.x_unknown === 7);

	console.log(
		"3. GIVEN logins to two MCPs  WHEN you logout of one  THEN the other's credentials are untouched"
	);
	seed({ servers: { [PROD]: auth("prod", PROD), [OTHER]: auth("other", OTHER) }, x_unknown: 7 });
	await cli(["logout"]); // default target = prod
	expect("prod slot removed", !(PROD in slots()));
	expect("other slot kept", OTHER in slots());
	expect("unknown key still preserved", readCfg().x_unknown === 7);

	// Tripwire, not proof: the race is timing-dependent. What prevents it is
	// re-read-at-write in checkForUpdate (a lost update) and tmp+rename in
	// writeConfig (a torn read).
	console.log(
		"4. GIVEN parallel commands all writing the config  WHEN they race  THEN nobody's login is ever wiped"
	);
	for (let round = 0; round < 3; round++) {
		seed({
			servers: { [PROD]: auth("prod", PROD), [OTHER]: auth("other", OTHER) },
			last_checked_at: 0
		});
		await Promise.all([cli(["whoami"]), cli(["whoami"]), cli(["whoami"]), cli(["whoami"])]);
		expect(`round ${round}: both slots survive`, Object.keys(slots()).length === 2);
	}
	expect("no orphan .tmp", !existsSync(`${CONFIG}.tmp`));

	console.log(
		"5. GIVEN a stored token with no recorded expiry  WHEN a command needs it  THEN the CLI refreshes first, never uses it stale"
	);
	// A stub server records which endpoint the binary reaches first. The refresh
	// path discovers the AS (/.well-known/...) before anything else; the old
	// skip-refresh bug went straight to the MCP (POST /) with the stale token.
	const hits: string[] = [];
	const stub = createServer((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		res.statusCode = 500;
		res.end("{}");
	});
	await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
	const port = (stub.address() as { port: number }).port;
	const stubUrl = `http://127.0.0.1:${port}`;
	seed({
		servers: {
			[stubUrl]: {
				client_id: "c",
				refresh_token: "r",
				tokens: { [stubUrl]: { access_token: "t", expires_at: 0 } }
			}
		}
	});
	await cli(["whoami"], { REDUCK_MCP_URL: stubUrl });
	stub.close();
	expect("refresh fired before any MCP call", refreshedBeforeCalling(hits));

	console.log(
		"6. GIVEN a fresh token for a DIFFERENT resource  WHEN a command needs this one  THEN the stored token is not reused"
	);
	// An access token is only valid at the resource it names, so one held for another resource
	// must not be presented here — the CLI has to go get one for this resource instead. Same
	// stub trick: reaching discovery proves it refreshed rather than reusing.
	const otherResourceHits: string[] = [];
	const stub2 = createServer((req, res) => {
		otherResourceHits.push(`${req.method} ${req.url}`);
		res.statusCode = 500;
		res.end("{}");
	});
	await new Promise<void>((r) => stub2.listen(0, "127.0.0.1", r));
	const stub2Url = `http://127.0.0.1:${(stub2.address() as { port: number }).port}`;
	seed({
		servers: {
			[stub2Url]: {
				client_id: "c",
				refresh_token: "r",
				// Fresh, but issued for somewhere else entirely.
				tokens: {
					"https://elsewhere.example": {
						access_token: "not-for-here",
						expires_at: Date.now() + 3_600_000
					}
				}
			}
		}
	});
	await cli(["whoami"], { REDUCK_MCP_URL: stub2Url });
	stub2.close();
	expect(
		"another resource's token is not reused for this one",
		refreshedBeforeCalling(otherResourceHits)
	);

	console.log(
		"7. GIVEN no login or garbage input  WHEN a command runs  THEN one clean error line, nonzero exit, no stack trace"
	);
	seed({});
	const noAuth = await cli(["list"]);
	expect(
		"unauthed list fails clean",
		noAuth.code !== 0 && noAuth.out.includes("Not authenticated")
	);
	const noScript = await cli(["run"]);
	expect(
		"run without --script rejected",
		noScript.code !== 0 && noScript.out.includes("--script")
	);
	const badId = await cli(["run", "--script", "not-a-script-id"]);
	expect(
		"malformed script address rejected",
		badId.code !== 0 && badId.out.includes("<host>/<slug>")
	);

	console.log("PASS: all auth/config assertions hold");
} finally {
	rmSync(HOME, { recursive: true, force: true });
}
