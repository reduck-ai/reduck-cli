#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync } from "node:fs";
import { openAsBlob } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";
import semver from "semver";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { extraAuthParams, extraHeaders } from "./extra.js";
import { deliverDownloads } from "./downloads.js";
import { openBrowser } from "./open.js";
import { registerFlockCommands, appTarget } from "./flock.js";

function formatError(err: unknown): string {
	if (err instanceof TypeError && err.message === "fetch failed") {
		const cause = (
			err as {
				cause?: {
					code?: string;
					message?: string;
					errors?: { address?: string; port?: number }[];
				};
			}
		).cause;
		const { address, port } = cause?.errors?.[0] ?? {};
		if (address && port)
			return `Could not connect to ${address}:${port}. Is the server running?`;
		const reason = cause?.code ?? cause?.message;
		return `Could not connect to server${reason ? ` (${reason})` : ""}. Is it running?`;
	}
	if (err instanceof Error) return err.message;
	return String(err);
}

process.on("uncaughtException", (err) => {
	console.error(`error: ${formatError(err)}`);
	process.exit(1);
});
process.on("unhandledRejection", (reason) => {
	console.error(`error: ${formatError(reason)}`);
	process.exit(1);
});

// ── Update check ─────────────────────────────────────────────────────────────

const UPDATE_CHECK_TTL = 60 * 60 * 1000; // 1 hour

function notifyIfOutdated(latest: string): void {
	if (semver.lt(VERSION, latest))
		console.error(
			`\nUpdate available: ${latest} (current: ${VERSION})\nRun \`npm i -g @reduck-ai/cli\` to upgrade.\n`
		);
}

// Refresh the cached latest version in the background when the TTL has expired.
// Returns a function that prints the update notice — call it after the command.
function checkForUpdate(): () => void {
	const config = readConfig();
	const fresh = config.last_checked_at && Date.now() - config.last_checked_at < UPDATE_CHECK_TTL;

	if (fresh)
		return () => {
			if (config.latest_version) notifyIfOutdated(config.latest_version);
		};

	let fetched: string | undefined;
	const done = (async () => {
		try {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 2000);
			const res = await fetch(`${appTarget()}/api/version`, {
				headers: extraHeaders(),
				signal: ac.signal
			});
			clearTimeout(timer);
			if (!res.ok) return;
			const { version: latest } = (await res.json()) as { version?: string };
			if (latest) fetched = latest;
		} catch {
			console.error("Failed to check for update.");
		} finally {
			// Re-read at write time: the fetch can take seconds, and writing back the
			// snapshot from before it would clobber any auth slot a concurrent
			// command persisted meanwhile.
			const current = readConfig();
			if (fetched) current.latest_version = fetched;
			current.last_checked_at = Date.now();
			writeConfig(current);
		}
	})();

	return async () => {
		await done;
		if (fetched) notifyIfOutdated(fetched);
	};
}

// ── MCP target ──────────────────────────────────────────────────────────────
// Default: the hosted MCP. REDUCK_MCP_URL points at any other MCP server. Auth
// state is per-origin, so switching targets never disturbs another origin's login.

const DEFAULT_MCP_URL = "https://mcp.reduck.ai";

const mcpTarget = (): string => process.env.REDUCK_MCP_URL?.trim() || DEFAULT_MCP_URL;

// ── Config ──────────────────────────────────────────────────────────────────
// Auth state is keyed by MCP origin: a client_id / token set is only meaningful
// relative to one authorization server, and each Reduck MCP fronts its own app.
// The update-check cache stays global. Stored 0600.

const CONFIG_DIR = join(homedir(), ".config", "reduck");
// REDUCK_CONFIG names another credentials file, so you can keep several identities.
const CONFIG_FILE = process.env.REDUCK_CONFIG ?? join(CONFIG_DIR, "config.json");

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"))
	.version as string;

interface StoredToken {
	access_token: string;
	expires_at: number;
}

interface Auth {
	client_id?: string;
	client_secret?: string;
	/** The scope set the registration above was made with.
	 *
	 *  KEPT SO IT CAN BE COMPARED. A client is registered with what the server advertised at the
	 *  time, and the authorization endpoint refuses a request for anything outside it. When Reduck
	 *  adds a scope, a durable registration therefore turns every later login into "the following
	 *  scopes are invalid" — a wall with no way past it but deleting this file by hand. */
	scope?: string;
	refresh_token?: string;
	// Access tokens keyed by the RFC 8707 resource they were issued for. One authorization
	// server can protect several resources — the MCP server and the Reduck API are distinct
	// ones — and a token is valid only at the resource it names. So one login yields one
	// refresh token, and a per-resource access token is requested from it as needed.
	tokens?: Record<string, StoredToken>;
}

interface Config {
	servers?: Record<string, Auth>; // keyed by MCP origin
	latest_version?: string;
	last_checked_at?: number;
}

// No migration from the pre-origin flat shape: legacy top-level auth keys are
// dropped (not lifted), so an old file reads as no `servers` → "not authenticated"
// → one re-login. Stripping on read lets the file self-heal to the canonical
// shape on the next write instead of carrying dead keys forever.
function readConfig(): Config {
	if (!existsSync(CONFIG_FILE)) return {};
	try {
		const { client_id, client_secret, access_token, refresh_token, expires_at, ...clean } =
			JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		return clean as Config;
	} catch {
		return {};
	}
}

// Atomic: write-then-rename, so a concurrent reader (e.g. checkForUpdate's
// background write racing another command) never sees a torn file — a torn
// read parses as {} and the next write would wipe every auth slot. The temp
// name is per-pid: parallel CLIs sharing one REDUCK_CONFIG
// each rename their own temp, so the second renamer never finds it already
// gone (ENOENT). Rename onto an existing destination is atomic — last writer
// wins, which is safe here (the value is a token + cache, not an accumulator).
function writeConfig(config: Config): void {
	mkdirSync(dirname(CONFIG_FILE), { recursive: true });
	const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
	renameSync(tmp, CONFIG_FILE);
}

const readAuth = (mcpUrl: string): Auth => readConfig().servers?.[new URL(mcpUrl).origin] ?? {};

function writeAuth(mcpUrl: string, auth: Auth): void {
	const config = readConfig();
	config.servers = { ...config.servers, [new URL(mcpUrl).origin]: auth };
	writeConfig(config);
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
// A plain OAuth 2.1 client: discover the resource, discover its authorization server, register,
// then authorization code + PKCE with an RFC 8707 `resource`. Nothing here is Reduck-specific.

// A loopback IP literal rather than the name `localhost`, per RFC 8252 (section 8.3): `localhost`
// resolves through the host file and may land on a non-loopback interface, and the port comparison
// is only waived for loopback IPs.
const CALLBACK_HOST = "127.0.0.1";
// The port is claimed from the OS per login, so it is not a well-known port another local process
// can hold or squat on ahead of this one. RFC 8252 (section 7.3) requires the authorization server
// to allow any port on a loopback redirect, which is what lets a registration made under one port
// still match a request made under the next.
const registeredCallbackUri = (port: number): string => `http://${CALLBACK_HOST}:${port}/callback`;
const CALLBACK_PATH = "/callback";

interface AuthServer {
	resource: string;
	issuer: string;
	scope: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint: string;
	revocation_endpoint?: string;
}

// OAuth 2.1 (section 1.5) and the MCP authorization specification both require every authorization
// server endpoint to be reached over TLS. A discovered document names the URLs this client is about
// to send a registration, an authorization code and a refresh token to, so a plain-http value there
// puts all three on the wire in the clear and lets anyone on the path rewrite them. Loopback is the
// documented local-development target and is exempt, because it never leaves the machine.
function requireSecureEndpoint(value: unknown, name: string): string {
	if (typeof value !== "string" || value === "")
		throw new Error(`authorization server metadata is missing ${name}`);
	const url = new URL(value);
	// `localhost` is included here, unlike in the redirect URI this client listens on: the risk RFC
	// 8252 (section 8.3) names is binding a listener to a name that may resolve off-loopback, which
	// does not apply to an outbound request to the local dev stack.
	const loopback = ["127.0.0.1", "::1", "[::1]", "localhost"].includes(url.hostname);
	if (url.protocol !== "https:" && !loopback)
		throw new Error(
			`${name} "${value}" is not https. Refusing to run OAuth over an unencrypted connection.`
		);
	return value;
}

// MCP: probe the endpoint unauthenticated and use the resource_metadata URL from the
// WWW-Authenticate challenge when present; otherwise fall back to the RFC 9728 well-known URL.
const redact = (url: string, secrets: string[]): string =>
	secrets.reduce((u, v) => (v ? u.replaceAll(encodeURIComponent(v), "***").replaceAll(v, "***") : u), url);

async function resourceMetadataUrl(mcpUrl: string, signal?: AbortSignal): Promise<string> {
	try {
		const res = await fetch(mcpUrl, { method: "GET", signal });
		const match = res.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/i);
		if (match?.[1]) return match[1];
	} catch {
		// probe failed; fall back to the well-known URL
	}
	return new URL("/.well-known/oauth-protected-resource", mcpUrl).href;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
	const res = await fetch(url, init);
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		let detail = body;
		try {
			const j = JSON.parse(body);
			detail = j.error_description ?? j.error ?? body;
		} catch {}
		throw new Error(
			`${init?.method ?? "GET"} ${url} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`
		);
	}
	return (await res.json()) as Record<string, unknown>;
}

// Discover the MCP's authorization server + the resource/scopes it expects
// (RFC 9728 → RFC 8414). The resource indicator is what stamps the token's
// audience to this MCP — the whole reason a plain app login won't authorize it.
async function discover(mcpUrl: string, signal?: AbortSignal): Promise<AuthServer> {
	const pr = await fetchJson(await resourceMetadataUrl(mcpUrl, signal), { signal });
	// RFC 9728 (section 3.3): the PRM resource MUST equal the identifier the well-known
	// URL was built from, else the document MUST NOT be used.
	if (pr.resource && pr.resource !== new URL(mcpUrl).origin)
		throw new Error(
			`resource mismatch: PRM says "${pr.resource}", expected "${new URL(mcpUrl).origin}"`
		);
	const as = (pr.authorization_servers as string[] | undefined)?.[0];
	if (!as) throw new Error(`${mcpUrl} advertises no authorization server`);
	// MCP requires trying the well-known endpoints in priority order, accepting the first whose
	// issuer round-trips per RFC 8414 (section 3.3). A path-bearing issuer has three candidates
	// (RFC 8414 OAuth path-insertion, OIDC path-insertion, then OIDC path-appending); a path-less
	// issuer has the two root variants. The well-known segment goes between host and path.
	const asUrl = new URL(as);
	const path = asUrl.pathname.replace(/\/$/, "");
	const wk = "/.well-known";
	const candidates = path
		? [
				`${asUrl.origin}${wk}/oauth-authorization-server${path}`,
				`${asUrl.origin}${wk}/openid-configuration${path}`,
				`${asUrl.origin}${path}${wk}/openid-configuration`
			]
		: [
				`${asUrl.origin}${wk}/oauth-authorization-server`,
				`${asUrl.origin}${wk}/openid-configuration`
			];
	let meta: Record<string, unknown> | undefined;
	for (const url of candidates) {
		try {
			const m = await fetchJson(url, { headers: extraHeaders(), signal });
			// RFC 8414 (section 3.3): the document is usable only if its `issuer` is identical
			// to the identifier the URL was built from. A mismatch means try the next candidate,
			// never adopt the document.
			if (m.issuer === as) {
				meta = m;
				break;
			}
		} catch {
			// try the next candidate
		}
	}
	if (!meta)
		throw new Error(
			`no authorization server metadata with matching issuer for "${as}". If the server needs a header of its own, set REDUCK_EXTRA_HEADERS, or use an API key (REDUCK_API_KEY).`
		);
	// PKCE support is not otherwise discoverable, so a client must refuse to proceed when the
	// authorization server does not advertise S256 (MCP authorization, "Authorization Code
	// Protection").
	const challengeMethods = (meta.code_challenge_methods_supported as string[] | undefined) ?? [];
	if (!challengeMethods.includes("S256"))
		throw new Error(`"${as}" does not advertise the S256 code challenge method`);
	// What the resource says it needs, plus `offline_access` when the authorization server offers
	// it. MCP puts that scope on the client's side of the line — a refresh token is the client's
	// requirement, not the resource's — so a client asks for it on its own authority and must not
	// depend on finding it in the resource's document, whether or not a given one lists it.
	const resourceScopes = (pr.scopes_supported as string[] | undefined) ?? [];
	const asScopes = (meta.scopes_supported as string[] | undefined) ?? [];
	const scopes = new Set(resourceScopes);
	if (asScopes.includes("offline_access")) scopes.add("offline_access");

	return {
		resource: (pr.resource as string) ?? new URL(mcpUrl).origin,
		issuer: as,
		scope: [...scopes].join(" "),
		authorization_endpoint: requireSecureEndpoint(
			meta.authorization_endpoint,
			"authorization_endpoint"
		),
		token_endpoint: requireSecureEndpoint(meta.token_endpoint, "token_endpoint"),
		registration_endpoint: requireSecureEndpoint(
			meta.registration_endpoint,
			"registration_endpoint"
		),
		revocation_endpoint:
			meta.revocation_endpoint === undefined
				? undefined
				: requireSecureEndpoint(meta.revocation_endpoint, "revocation_endpoint")
	};
}

function pkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

interface CallbackServer {
	/** The `redirect_uri` to register and to send on the authorization request. */
	redirectUri: string;
	/** Resolves with the authorization code once state and issuer both check out. */
	code(expected: { state: string; issuer: string }): Promise<string>;
	close(): void;
}

// Bound to the loopback address explicitly: the default binds every interface, which would let
// anything that can route to this machine reach the callback during the login window.
async function startCallbackServer(): Promise<CallbackServer> {
	let settle: ((result: { code: string } | { error: Error }) => void) | undefined;
	let expected: { state: string; issuer: string } | undefined;

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://${CALLBACK_HOST}`);
		// Requests to any other path come from something else on the machine (a browser probing
		// for a favicon, a port scan). They get an answer and the server keeps waiting, so a stray
		// request cannot end the login.
		if (url.pathname !== CALLBACK_PATH) {
			res.writeHead(404).end();
			return;
		}

		const params = url.searchParams;
		const code = params.get("code");
		const failure = ((): Error | null => {
			if (!code) return new Error(params.get("error_description") ?? "No code received");
			// `state` is this client's CSRF binding, and RFC 9207's `iss` is the mix-up defence.
			// Both are checked before anything is reported as successful, so the page a user reads
			// never claims more than what was verified.
			if (params.get("state") !== expected?.state)
				return new Error("State mismatch — possible CSRF");
			const iss = params.get("iss");
			if (iss !== expected?.issuer)
				return new Error(
					`iss mismatch: callback "${iss}" != authorization server "${expected?.issuer}"`
				);
			return null;
		})();

		const msg = failure
			? `Authentication failed: ${failure.message}`
			: "Authentication successful — you can close this tab.";
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			// The URL carries an authorization code, so keep it out of caches and out of the
			// Referer of anything this page might reach.
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer"
		});
		res.end(
			`<html><body style="font-family:sans-serif;padding:2rem">${escapeHtml(msg)}</body></html>`
		);
		settle?.(failure ? { error: failure } : { code: code as string });
	});

	const port = await new Promise<number>((resolvePort, rejectPort) => {
		server.once("error", rejectPort);
		// Port 0 asks the OS for a free ephemeral port (RFC 8252, section 7.3).
		server.listen(0, CALLBACK_HOST, () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				rejectPort(new Error("callback server did not bind a TCP port"));
				return;
			}
			resolvePort(address.port);
		});
	});

	const close = () => {
		server.closeAllConnections();
		server.close();
	};

	return {
		redirectUri: registeredCallbackUri(port),
		close,
		code: (want) =>
			new Promise<string>((resolveCode, rejectCode) => {
				expected = want;
				const timeout = setTimeout(() => {
					close();
					rejectCode(new Error("Login timed out after 2 minutes"));
				}, 120_000);
				settle = (result) => {
					clearTimeout(timeout);
					close();
					if ("code" in result) resolveCode(result.code);
					else rejectCode(result.error);
				};
			})
	};
}

// RFC 7591. `scope` is sent explicitly so the registration records what this client will
// actually ask for, rather than inheriting whatever the server's default happens to be.
function registerClient(
	as: AuthServer,
	redirectUri: string
): Promise<{ client_id: string; client_secret?: string }> {
	const origin = new URL(as.registration_endpoint).origin;
	return fetchJson(as.registration_endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: origin, ...extraHeaders() },
		body: JSON.stringify({
			client_name: "Reduck CLI",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: as.scope
		})
	}).then((reg) => ({
		client_id: reg.client_id as string,
		client_secret: reg.client_secret as string | undefined
	}));
}

// A token request, for either grant. The RFC 8707 `resource` is what binds the issued token to
// one resource, so it is never omitted: without it an authorization server is free to issue a
// token no resource server can verify as its own.
async function requestToken(
	as: AuthServer,
	auth: Auth,
	resource: string,
	grant: Record<string, string>
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
	const body = new URLSearchParams({
		...grant,
		client_id: auth.client_id!,
		resource,
		...(auth.client_secret ? { client_secret: auth.client_secret } : {})
	});
	return (await fetchJson(as.token_endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Origin: new URL(as.token_endpoint).origin,
			...extraHeaders()
		},
		body
	})) as { access_token: string; refresh_token?: string; expires_in: number };
}

const storeToken = (
	mcpUrl: string,
	auth: Auth,
	resource: string,
	tok: { access_token: string; refresh_token?: string; expires_in: number }
): Auth => {
	const updated: Auth = {
		...auth,
		// Rotated on every use for a public client (OAuth 2.1, section 4.3.1), so the response's
		// refresh token replaces the stored one whenever it carries a new one.
		...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
		tokens: {
			...auth.tokens,
			[resource]: {
				access_token: tok.access_token,
				expires_at: Date.now() + tok.expires_in * 1000
			}
		}
	};
	writeAuth(mcpUrl, updated);
	return updated;
};

async function login(mcpUrl: string, appUrl: string): Promise<void> {
	const as = await discover(mcpUrl);

	// Claim the port before registering, so the registration and the authorization request name the
	// same `redirect_uri`. A reused registration from an earlier login carries an older port, which
	// the authorization server ignores for a loopback host (RFC 8252, section 7.3).
	const callback = await startCallbackServer();
	try {
		// Reuse the registration when there is one AND it still covers what we are about to ask
		// for. A public client's registration is durable, so re-registering on every login writes
		// a new row on the authorization server each time — but a registration made before a scope
		// existed cannot be used to request it, and reusing one is how a login that was working
		// yesterday starts refusing today.
		const existing = readAuth(mcpUrl);
		const reusable = existing.client_id && existing.scope === as.scope;
		const registered = reusable
			? { client_id: existing.client_id!, client_secret: existing.client_secret }
			: await registerClient(as, callback.redirectUri);

		const { verifier, challenge } = pkce();
		const state = randomBytes(16).toString("hex");
		const params = new URLSearchParams({
			client_id: registered.client_id,
			redirect_uri: callback.redirectUri,
			response_type: "code",
			scope: as.scope,
			resource: as.resource,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state
		});
		// The app's API is a second resource of this authorization server, and a refresh token
		// mints tokens only for the resources its authorization named (RFC 8707). Naming the app
		// here is what lets `getToken` reach it later without another sign-in. Only when the app is
		// on the authorization server's origin: this server issues no token for an app elsewhere,
		// and an unknown resource fails the whole authorization.
		if (new URL(appUrl).origin === new URL(as.issuer).origin) params.append("resource", appUrl);
		// A browser leg cannot carry a header: what the environment adds goes into the URL.
		const extra = extraAuthParams();
		for (const [k, v] of Object.entries(extra)) params.set(k, v);
		const authUrl = `${as.authorization_endpoint}?${params}`;

		console.error("Opening your browser for authentication…");
		openBrowser(authUrl);
		// The values the environment added can be secrets: the copy-paste fallback hides them.
		console.error(
			`\nIf the browser didn't open:\n  ${redact(authUrl, Object.values(extra))}\n`
		);

		// State and RFC 9207 `iss` are both verified inside the callback server, before it reports
		// success to the user.
		const code = await callback.code({ state, issuer: as.issuer });

		const auth: Auth = {
			client_id: registered.client_id,
			client_secret: registered.client_secret,
			scope: as.scope
		};
		const tok = await requestToken(as, auth, as.resource, {
			grant_type: "authorization_code",
			code,
			redirect_uri: callback.redirectUri,
			code_verifier: verifier
		});
		storeToken(mcpUrl, auth, as.resource, tok);
		console.error("Signed in.");
	} finally {
		callback.close();
	}
}

async function refresh(auth: Auth, mcpUrl: string, resource: string): Promise<Auth> {
	const as = await discover(mcpUrl);
	const tok = await requestToken(as, auth, resource, {
		grant_type: "refresh_token",
		refresh_token: auth.refresh_token!
	}).catch(() => {
		throw new Error("You are signed out. Run `npx @reduck-ai/cli@latest login`.");
	});
	return storeToken(mcpUrl, auth, resource, tok);
}

// An access token for `resource`, refreshed on demand. `resource` defaults to the MCP server's
// own identifier; another resource the login authorized is reached by naming it, and gets its own
// token from the same refresh token — one login, no extra consent.
async function getToken(mcpUrl: string, resource = new URL(mcpUrl).origin): Promise<string> {
	const fresh = (a: Auth) => {
		const stored = a.tokens?.[resource];
		return stored && Date.now() < stored.expires_at - 30_000 ? stored.access_token : undefined;
	};

	let auth = readAuth(mcpUrl);
	if (!auth.refresh_token && !auth.tokens) {
		console.error(
			"Not authenticated. Run `npx @reduck-ai/cli@latest login`, or set REDUCK_API_KEY."
		);
		process.exit(1);
	}
	const current = fresh(auth);
	if (current) return current;

	// Expired, or never held for this resource. Under concurrent CLI processes sharing one
	// config file, the single-use refresh token is rotated by the first winner; every other
	// process sees invalid_grant. Loop: on each failure, back off and re-read the file — the
	// winner may not have written back yet (its HTTP response is still in flight while losers
	// already got their 400). A fresh access token means someone else refreshed for us; a newer
	// refresh token means we can retry ourselves. Give up after several attempts with no progress.
	try {
		auth = await refresh(auth, mcpUrl, resource);
	} catch (e) {
		// Back off so the winning process has time to receive its response and write the
		// config before we re-read.
		await new Promise((r) => setTimeout(r, 150));
		const reread = readAuth(mcpUrl);
		const raced = fresh(reread);
		if (raced) return raced;
		throw e;
	}
	const token = auth.tokens?.[resource]?.access_token;
	if (!token) throw new Error(`no access token issued for "${resource}"`);
	return token;
}

// ── MCP client ──────────────────────────────────────────────────────────────

type RunOutcome = {
	result?: unknown;
	error?: string;
	runId?: string;
	// The run envelope's discriminant: completed | failed | queued | running.
	// queued/running mean the run outlived the tool call's wait and continues
	// server-side — poll read_run_results after retryAfterMs.
	status?: string;
	retryAfterMs?: number;
	// On a classified failure: the bucket (script/user/internal) + the actionable
	// user-facing line. Both empty on success or an unclassified error.
	errorType?: string;
	externalMessage?: string;
};
// A single run carries result/error/runId directly; several --script carry one
// outcome per script under `runs`, plus `batchId` — the batch's own id (never any
// run's), which polls every script in one call. Both doors answer with this same
// envelope, which is what lets the poll-and-render tail below serve either.
type Envelope = RunOutcome & {
	runs?: RunOutcome[];
	totalSteps?: number;
	batchId?: string;
};

type ToolResult = {
	content?: { type: string; text?: string }[];
	structuredContent?: Envelope;
	isError?: boolean;
};

// Resolve the MCP target + its auth header. Done up front so commands fail fast
// on missing auth before any expensive work.
// An API key (REDUCK_API_KEY) short-circuits OAuth entirely — the server accepts
// it as x-api-key on both the MCP door and POST /run.
// The credential for one resource. An access token names the single resource it was issued
// for, so which resource is asked for here is the whole difference between the header the MCP
// accepts and the one the app accepts; both are minted from the same refresh token, so naming
// a second one costs no further sign-in. An API key names no resource and is accepted by both.
async function resourceAuth(resource: string): Promise<Record<string, string>> {
	const apiKey = process.env.REDUCK_API_KEY?.trim();
	if (apiKey) return { "x-api-key": apiKey };
	return { Authorization: `Bearer ${await getToken(mcpTarget(), resource)}` };
}

async function mcpAuth(): Promise<{ url: string; headers: Record<string, string> }> {
	const url = mcpTarget();
	return { url, headers: await resourceAuth(url) };
}

async function callMcp(
	target: { url: string; headers: Record<string, string> },
	name: string,
	args: Record<string, unknown>
): Promise<ToolResult> {
	const transport = new StreamableHTTPClientTransport(new URL(target.url), {
		requestInit: { headers: target.headers }
	});
	const client = new Client({ name: "reduck-cli", version: VERSION });
	await client.connect(transport);
	try {
		// The MCP gates every tool behind a once-per-session read_docs; honor that
		// handshake before the real call (skipping it when the call *is* read_docs).
		if (name !== "read_docs") await client.callTool({ name: "read_docs", arguments: {} });
		// A run legitimately outlives the SDK's 60s default (cold browser spawn,
		// heavy scrape) — the client must not abort a healthy in-flight run. Raise
		// the per-request deadline; resetTimeoutOnProgress lets server progress
		// notifications (when run_script emits them) extend it up to maxTotalTimeout.
		const opts = { timeout: 180_000, resetTimeoutOnProgress: true, maxTotalTimeout: 600_000 };
		return (await client.callTool({ name, arguments: args }, undefined, opts)) as ToolResult;
	} finally {
		// One-shot: a CLI command owns its MCP session for exactly that command.
		// End the MCP session so the server releases its browser.
		await transport.terminateSession().catch(() => {});
		await client.close().catch(() => {});
	}
}

function printResult(result: ToolResult): void {
	for (const part of result.content ?? []) if (part.type === "text") console.log(part.text);
	if (result.isError) process.exitCode = 1;
}

// On a classified failure: print the verdict (bucket + actionable line) to stderr
// under the error, and return the two fields to fold into the JSON outcome — so both
// channels carry it. No-op (and {}) on success or an unclassified error. The actionable
// line is the error told to the user, so it is left out when the error already says it
// (an args error), as the MCP's own text does.
function reportVerdict(
	o: RunOutcome,
	prefix = ""
): { errorType?: string; externalMessage?: string } {
	if (!o.errorType) return {};
	const repeats = !o.externalMessage || (o.error ?? "").includes(o.externalMessage);
	console.error(`${prefix}⚠ ${o.errorType}${repeats ? "" : `: ${o.externalMessage}`}`);
	return { errorType: o.errorType, externalMessage: o.externalMessage };
}

// ── list ──────────────────────────────────────────────────────────────────

async function listCmd(
	handle: string | undefined,
	{
		host,
		query,
		visibility,
		archived = "exclude"
	}: { host?: string; query?: string; visibility?: string; archived?: string }
): Promise<void> {
	printResult(
		await callMcp(await mcpAuth(), "list_scripts", {
			...(handle && { handle }),
			...(query && { q: query }),
			...(host && { host }),
			...(visibility && { visibility }),
			archived
		})
	);
}

// ── run ───────────────────────────────────────────────────────────────────

interface RunOpts {
	script?: string[];
	sequential?: boolean;
	obs?: boolean;
	out?: string;
	device?: string;
	versionId?: string;
}

interface RunStep {
	handle?: string;
	host: string;
	slug: string;
	args: Record<string, unknown>;
	versionId?: string;
	// File inputs for this step: declared target filename → local source path.
	// Bound via `file:<name>=<path>` tokens after the step's --script address.
	files: Record<string, string>;
}

// The address grammar `list` prints: [<handle>/]<host>/<slug>. Bare host/slug is
// your own script; a handle prefix addresses that owner's public script — "@user"
// for a user, a bare project handle (e.g. "reduck", the official catalogue) for a
// project. The handle is carried verbatim (the app decodes it). Host and slug are
// flat segments, so the segment count alone tells a 2-part own ref from a 3-part
// owned ref — no marker needed. Shared by `run` and `read`.
function parseScriptAddress(addr: string): { handle?: string; host: string; slug: string } {
	const parts = addr.split("/");
	if (parts.length === 3 && parts.every(Boolean)) {
		const [handle, host, slug] = parts;
		return { handle, host, slug };
	}
	if (parts.length === 2 && parts.every(Boolean)) {
		const [host, slug] = parts;
		return { host, slug };
	}
	return program.error(
		"script must be [<handle>/]<host>/<slug>, e.g. reduck/linkedin.com/get_post"
	);
}

async function readCmd(
	script: string,
	opts: { code?: boolean; versionId?: string }
): Promise<void> {
	const { handle, host, slug } = parseScriptAddress(script);
	printResult(
		await callMcp(await mcpAuth(), "read_script", {
			host,
			slug,
			handle,
			includeScript: !!opts.code,
			...(opts.versionId ? { version_id: opts.versionId } : {})
		})
	);
}

// Commander flattens a repeated variadic option into one token list, so we re-group
// here. One --script occurrence is `<addr> [key=value...]`: a token without `=` is the
// next script's address (starts a step), a `key=value` token is an arg of the current
// step. A `file:<name>=<path>` token binds a file input (a property the script's input
// schema marks { format: "file" }) to a local file. Arg values parse as JSON when they
// can (numbers, booleans, arrays), else the raw string — so `count=5` is 5, `name=bob`
// is "bob".
function parseScriptSteps(tokens: string[]): RunStep[] {
	const steps: RunStep[] = [];
	for (const tok of tokens) {
		const eq = tok.indexOf("=");
		if (eq === -1) {
			steps.push({ ...parseScriptAddress(tok), args: {}, files: {} });
			continue;
		}
		if (eq === 0 || !steps.length)
			program.error(
				`invalid --script token: ${tok} (expected a script address or key=value after it)`
			);
		const cur = steps[steps.length - 1];
		const key = tok.slice(0, eq);
		const raw = tok.slice(eq + 1);
		// `file:<name>=<path>` binds a file input; everything else is an arg.
		if (key.startsWith("file:")) {
			const name = key.slice("file:".length);
			if (!name) program.error(`invalid file token: ${tok} (expected file:<name>=<path>)`);
			cur.files[name] = raw;
			continue;
		}
		try {
			cur.args[key] = JSON.parse(raw);
		} catch {
			cur.args[key] = raw;
		}
	}
	if (!steps.length) program.error("no --script given (use --script <addr> [key=value...])");
	return steps;
}

function assertReadable(step: RunStep, name: string): string {
	const src = step.files[name];
	if (!existsSync(src) || !statSync(src).isFile())
		program.error(`file:${name} (${step.host}/${step.slug}): no such file: ${src}`);
	return src;
}

async function runCmd(opts: RunOpts): Promise<void> {
	// --obs printed the trace the run response used to carry; a run outside a session
	// no longer carries one, so the flag has nothing left to print. It stays accepted
	// (and hidden from help) for one deprecation window: an existing script or CI job
	// keeps working with a warning instead of dying on "unknown option".
	if (opts.obs)
		console.error(
			"warning: --obs no longer does anything and will be rejected in a future " +
				"release, so drop it. The step trace is now read separately, with the " +
				"MCP's read_run_trace({runId}), using the run_id this command prints on stderr."
		);
	const steps = parseScriptSteps(opts.script ?? []);
	if (opts.versionId) {
		if (steps.length !== 1)
			return program.error("--version-id is only supported for single-script runs");
		steps[0].versionId = opts.versionId;
	}

	const target = await mcpAuth(); // fail fast on missing auth

	// The device lives behind the Browser Provider, and the MCP resolves it
	// (auto-picks the single online device, or the one named by --device).
	// A run with no online device fails clean server-side.

	if (opts.sequential && steps.length < 2)
		return program.error(
			"--sequential needs at least two --script (there is nothing to order)"
		);

	// One --script → the single-script request (and a single result, exactly as before);
	// two or more → each on its own browser, all at once, unless --sequential chains them
	// through one browser in order (fail-fast).
	const single = steps.length === 1 ? steps[0] : null;
	await runViaMcp(target, steps, single, opts);
}

// Start a run whose steps bind file inputs, by POSTing the bytes to the REST door.
//
// This is the only command that leaves the MCP transport, and only because JSON-RPC has
// nowhere to put a 50 MB file: the tool call would have to base64 it into the params,
// inflating it by a third and holding it all in memory on both ends. The multipart door
// streams each part instead.
//
// The response is the same envelope the tool returns — 200 when the run already settled,
// 202 with a handle when it outlived the wait — so the caller polls and renders it
// through exactly the same path as a file-less run.
async function startRunWithFiles(
	target: { url: string; headers: Record<string, string> },
	steps: RunStep[],
	spec: Record<string, unknown>
): Promise<Envelope> {
	// The two doors disagree about what "no browser named" means: run_script auto-picks a
	// device, POST /run uses a cloud browser when none is named, and its `browser` field is device-only so there is no value meaning "auto-pick".
	// Left alone, moving a file run to this door would silently move it off the user's
	// own browser and onto a billable one. `reduck run` is a device tool, so name one.
	// --device (already in `spec` as deviceId) wins; otherwise the paired extension, which
	// is what this command's help has always promised.
	const form = new FormData();
	form.append("spec", JSON.stringify(spec.deviceId ? spec : { ...spec, browser: "extension" }));
	for (const [i, step] of steps.entries())
		for (const name of Object.keys(step.files))
			// openAsBlob keeps the file on disk and lets fetch stream it, so the CLI never
			// holds the bytes in memory either. The part name is <step>:<target filename>,
			// which is how the server knows which step declared it.
			form.append(`${i}:${name}`, await openAsBlob(assertReadable(step, name)), name);

	// fetch collapses every transport failure into the message "fetch failed" and hides
	// the real one on `cause` — useless for a user staring at a failed upload, so unwrap it.
	let res: Response;
	try {
		res = await fetch(new URL("/run", target.url), {
			method: "POST",
			// Content-Type is deliberately absent: fetch derives it from the FormData,
			// including the multipart boundary, and setting it by hand would drop that.
			headers: target.headers,
			body: form
		});
	} catch (e) {
		const cause = (e as { cause?: unknown }).cause;
		const detail = cause instanceof Error ? cause.message : cause ? String(cause) : "";
		throw new Error(
			`could not upload to ${new URL("/run", target.url)}: ${
				e instanceof Error ? e.message : String(e)
			}${detail ? ` (${detail})` : ""}`
		);
	}
	const text = await res.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`run failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
	}
	// 200 = settled, 202 = still running and pollable. Anything else carries {error}.
	if (!res.ok && res.status !== 202)
		throw new Error((body as { error?: string }).error ?? `run failed (HTTP ${res.status})`);
	return body as Envelope;
}

async function runViaMcp(
	target: { url: string; headers: Record<string, string> },
	steps: RunStep[],
	single: RunStep | null,
	opts: RunOpts
): Promise<void> {
	// A step never names a file here. When bytes are bound they ride the request and
	// POST /run attaches each part to its step server-side, from the parts it actually
	// received — a path in the spec would be both redundant and a claim about a
	// filesystem the server may not share.
	const uploading = steps.some((s) => Object.keys(s.files).length);
	const toMcpStep = (s: RunStep) => ({
		host: s.host,
		slug: s.slug,
		handle: s.handle,
		args: s.args,
		...(s.versionId ? { version_id: s.versionId } : {})
	});
	// Same run params either way — only the door differs, and only because one of them
	// can carry bytes.
	const spec = {
		// A script ref and its args are one object, under `script` for a single run or as
		// an entry of `scripts` for several — never spread across the run's own params.
		...(single ? { script: toMcpStep(single) } : { scripts: steps.map(toMcpStep) }),
		// Chain the scripts through one browser instead of giving each its own. The MCP accepts
		// it but leaves it out of its tool schema on purpose: the CLI is a human surface, so it
		// names the flag.
		...(opts.sequential ? { sequential: true } : {}),
		// --device targets a specific registered device (omit to auto-pick the single
		// online one).
		...(opts.device ? { deviceId: opts.device } : {}),
		// Hold the call near the server's wait cap to keep the blocking CLI feel; a run
		// that outlives it detaches and is polled below.
		waitForSeconds: 55
	};

	const outDir = opts.out ?? join(homedir(), "Downloads");
	let sc: Envelope | undefined;

	// A run that binds files uploads their BYTES, which the JSON-RPC tool call cannot
	// carry — so it goes through the REST door's multipart form instead. That is the
	// whole reason for the second transport, and it is what lets a file input run on a
	// cloud browser at all: the bytes travel to the run, rather than the run being told
	// to find a file on a machine it has no access to.
	if (uploading) {
		try {
			sc = await startRunWithFiles(target, steps, spec);
		} catch (e) {
			console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
			process.exitCode = 1;
			return;
		}
	} else {
		const result = await callMcp(target, "run_script", spec);
		sc = result.structuredContent;
		// A thrown tool error (bad request, no device, …) carries its message in content
		// and has no structuredContent — surface it the same way for both forms.
		if (result.isError && !sc) {
			const msg = (result.content ?? []).find((p) => p.type === "text")?.text ?? "run failed";
			console.error(`error: ${msg}`);
			process.exitCode = 1;
			return;
		}
	}

	// The run outlived the wait (device at its concurrency budget, or just slow) and
	// continues server-side — poll read_run_results until the envelope is terminal. A
	// batch is polled by its own `batchId` (which reports every script) and a lone run by
	// its `runId`: the two are different ids and different parameters, so a run id never
	// answers for a batch or the other way round.
	for (;;) {
		if (sc?.status !== "queued" && sc?.status !== "running") break;
		const poll = sc.batchId ? { batchId: sc.batchId } : sc.runId ? { runId: sc.runId } : null;
		if (!poll) break;
		console.error(
			`${sc.status}… (${sc.batchId ? "batch_id" : "run_id"}: ${Object.values(poll)[0]})`
		);
		await new Promise((r) => setTimeout(r, sc?.retryAfterMs ?? 10_000));
		const polled = await callMcp(target, "read_run_results", poll);
		sc = (polled.structuredContent as typeof sc) ?? sc;
	}

	if (single) {
		// Meta channel: the run id, on stderr so stdout
		// stays pure JSON. Printed regardless of outcome — a failed run is still tracked.
		if (sc?.runId) console.error(`run_id: ${sc.runId}`);
		if (sc?.error !== undefined) {
			console.error(`error: ${sc.error}`);
			reportVerdict(sc);
			process.exitCode = 1;
		} else if (sc && sc.result !== undefined) {
			// Consummate any download envelope: move artifacts out of the local downloads
			// folder to --out (default: ~/Downloads) under their real names, and print the result with
			// `path` rewritten to where the file actually landed.
			console.log(JSON.stringify(await deliverDownloads(sc.result, outDir), null, 2));
		}
		return;
	}

	// Several scripts: one outcome per script, in the order given — always one each, with
	// --sequential reporting the ones after a failure as never having run. Run ids and
	// per-script errors go to stderr (tagged with the script), the results to stdout.
	const runs = sc?.runs ?? [];
	const delivered: unknown[] = [];
	let failed = false;
	for (let i = 0; i < runs.length; i++) {
		const r = runs[i];
		const ref = `${steps[i].host}/${steps[i].slug}`;
		if (r.runId) console.error(`run_id[${ref}]: ${r.runId}`);
		if (r.error !== undefined) {
			console.error(`error[${ref}]: ${r.error}`);
			failed = true;
			delivered.push({ error: r.error, ...reportVerdict(r, `[${ref}] `) });
		} else {
			delivered.push(await deliverDownloads(r.result, outDir));
		}
	}
	console.log(JSON.stringify(delivered, null, 2));
	if (failed) process.exitCode = 1;
}

// ── Program ───────────────────────────────────────────────────────────────────

const program = new Command()
	.name("npx @reduck-ai/cli@latest")
	.description("Run Reduck scripts against your browser, via the Reduck MCP.")
	.version(VERSION);

// A hidden command runs when typed but is absent from this listing, so a reader who has not been
// told one exists has no way to find it. Naming the switch costs one line and is the difference
// between a command that is gated and one that looks like it was never built.
if (!process.env.REDUCK_EXPERIMENTAL?.trim())
	program.addHelpText(
		"after",
		"\nSome commands are experimental and hidden from this list. Set REDUCK_EXPERIMENTAL=1 to show them."
	);

program
	.command("login")
	.description("Authenticate against the Reduck MCP (OAuth2 PKCE).")
	.action(async () => login(mcpTarget(), appTarget()));

program
	.command("logout")
	.description("Revoke and remove saved credentials for the active MCP target.")
	.action(async () => {
		const mcpUrl = mcpTarget();
		const auth = readAuth(mcpUrl);

		// RFC 7009. Revoking the refresh token is what actually ends the grant — dropping the
		// local file alone would leave it usable until it expires. A public client authenticates
		// with `client_id` alone, and the endpoint answers 200 even for an already-invalid token,
		// so a failure here means the server could not be reached: say so rather than imply a
		// revocation that did not happen, and clear the local state regardless.
		//
		// Time-boxed because logging out must not hang on an unreachable network.
		if (auth.refresh_token && auth.client_id) {
			try {
				const signal = AbortSignal.timeout(5_000);
				const as = await discover(mcpUrl, signal);
				if (!as.revocation_endpoint) throw new Error("no revocation_endpoint advertised");
				const res = await fetch(as.revocation_endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						...extraHeaders()
					},
					body: new URLSearchParams({
						token: auth.refresh_token,
						token_type_hint: "refresh_token",
						client_id: auth.client_id,
						...(auth.client_secret ? { client_secret: auth.client_secret } : {})
					}),
					signal
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
			} catch (e) {
				console.error(
					`Warning: could not revoke the refresh token server-side (${e instanceof Error ? e.message : e}). It stays valid until it expires.`
				);
			}
		}

		const config = readConfig();
		if (config.servers) delete config.servers[new URL(mcpUrl).origin];
		writeConfig(config);
		console.error("Logged out.");
	});

program
	.command("list")
	.alias("ls")
	.argument(
		"[handle]",
		'Optional owner scope: "@user" (with @) for a user, or a project handle (without @), e.g. "reduck" for the official scripts. Omit for a cross-owner search.'
	)
	.option(
		"-q, --query <q>",
		"Search across name, slug, host, description and the input/output schemas. Ranks by relevance."
	)
	.option("--host <host>", "Filter by host (e.g. linkedin.com).")
	.addOption(
		new Option(
			"--visibility <visibility>",
			'Visibility filter: "public" or "private". Omit to show both.'
		).choices(["public", "private"])
	)
	.addOption(
		new Option(
			"--archived <filter>",
			'Archive filter: "exclude" (default) hides archived, "only" shows archived exclusively, "include" shows both.'
		)
			.choices(["exclude", "include", "only"])
			.default("exclude")
	)
	.description(
		"List scripts. Without a handle, searches across your own, your projects', and the official scripts. With a handle, scopes to that owner."
	)
	.action(listCmd)
	.addHelpText(
		"after",
		`
Examples:
  $ npx @reduck-ai/cli@latest list
  $ npx @reduck-ai/cli@latest list -q linkedin
  $ npx @reduck-ai/cli@latest list reduck
  $ npx @reduck-ai/cli@latest list @myhandle -q scrape
  $ npx @reduck-ai/cli@latest list myproject --host linkedin.com`
	);

program
	.command("read")
	.argument(
		"<script>",
		"Script address as printed by `list`: [<handle>/]<host>/<slug>. Bare host/slug = your own; a handle prefix (@user or a project like reduck for the official scripts) = that owner's public script."
	)
	.option(
		"--code",
		"Also print the raw script body (the contract — description, loggedIn, input/output schemas — is always shown)."
	)
	.option(
		"--version-id <id>",
		"Read a specific version instead of the current one (from list_script_versions)."
	)
	.description(
		"Read a saved script's contract (loggedIn + input/output JSON Schemas) via the MCP's read_script — the arg names to pass to `run`."
	)
	.action(readCmd)
	.addHelpText(
		"after",
		`
Examples:
  $ npx @reduck-ai/cli@latest read news.ycombinator.com/top
  $ npx @reduck-ai/cli@latest read reduck/linkedin.com/get_post --code`
	);

program
	.command("skill")
	.argument("[name]", "Doc name from the overview index; omit for the overview.")
	.description("Print Reduck skill docs to stdout. Public: you do not need to sign in.")
	.action(async (name?: string) => {
		const res = await fetch(
			new URL(`/skill${name ? `/${encodeURIComponent(name)}` : ""}`, mcpTarget())
		);
		const body = await res.text();
		if (!res.ok) {
			let msg = body;
			try {
				msg = (JSON.parse(body) as { error?: string }).error ?? body;
			} catch {}
			console.error(`error: ${msg}`);
			process.exitCode = 1;
			return;
		}
		console.log(body);
	})
	.addHelpText(
		"after",
		`
Examples:
  $ npx @reduck-ai/cli@latest skill
  $ npx @reduck-ai/cli@latest skill authoring_scripts`
	);

program
	.command("whoami")
	.description("Show which Reduck account the CLI is authenticated as.")
	.action(async () => printResult(await callMcp(await mcpAuth(), "whoami", {})));

program
	.command("run")
	.description(
		"Run one or more saved scripts via the MCP's run_script — on your browser, via the paired extension. Repeat --script to run several at once, each on its own browser."
	)
	.option(
		"--script <addr...>",
		"A script to run: its address ([<handle>/]<host>/<slug>) followed by its key=value args, e.g. `--script linkedin.com/get_post url=… max=5`. Bare addr = your own; a handle prefix (@user, or a project like reduck for the official scripts) = that owner's public script. Arg values are coerced to the script's type: plain `siret=913…` stays a string, pass JSON for arrays/objects (`ids=[1,2]`). Bind a file input with `file:<input>=<path>` (e.g. `file:attachment=./banner.png`). The file is uploaded with the run, and the page gets it under the input's name, so pass the script's own name input if it has one (send_email: attachmentName). Repeat --script to run several at once, each on its own browser (see --sequential to chain them instead).",
		(val: string, prev: string[]) => [...prev, val],
		[]
	)
	.option(
		"--sequential",
		"Chain the --script list through ONE browser, in order, instead of running them at once: each script inherits the previous one's cookies, page and navigation (not its result). Stops at the first failure. Use it when a script needs the state another leaves behind (sign in, then act)."
	)
	.option(
		"--device <id>",
		"Target a specific registered device (id from `list_devices`) instead of auto-picking the paired extension."
	)
	.option(
		"--out <dir>",
		"Directory to deliver downloaded files into, under their real names (default: ~/Downloads)."
	)
	.option(
		"--version-id <id>",
		"Run a specific version instead of the current one (from list_script_versions). Only for single-script runs."
	)
	// Deprecated and undocumented: accepted so an existing caller warns instead of
	// failing, hidden so nothing points a new one at it. See runCmd.
	.addOption(new Option("--obs", "Deprecated, ignored.").hideHelp())
	.action(runCmd)
	.addHelpText(
		"after",
		`
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
\`npx @reduck-ai/cli@latest login\` once per server.

Examples:
  $ npx @reduck-ai/cli@latest run --script linkedin.com/get_profile_info username=williamhgates
  $ npx @reduck-ai/cli@latest run --script reduck/linkedin.com/get_post url=…   # official scripts
  $ npx @reduck-ai/cli@latest run --script news.ycombinator.com/top --device 4f3c…   # a specific device
  $ npx @reduck-ai/cli@latest run --script reduck/mail.google.com/send_email to=me@example.com subject=Hi attachmentName=banner.png file:attachment=./banner.png   # file input
  $ npx @reduck-ai/cli@latest run --script site.com/a --script site.com/b   # both at once, a browser each
  $ npx @reduck-ai/cli@latest run --sequential --script site.com/login --script site.com/scrape max=5   # chain, one browser
  $ REDUCK_MCP_URL=https://mcp.example.com npx @reduck-ai/cli@latest run --script example.com/title`
	);

// `reduck flock …` — deploy a folder as a hosted app and operate it afterwards. It speaks to
// two hosts: the Reduck app owns the apps themselves (creating one, its releases, its secrets,
// who may open it), while the flock host owns what only it can answer for — the records, the
// corpus, and the bytes on its disk. One sign-in covers both; see resourceAuth.
registerFlockCommands(program, {
	mcpAuth: () => resourceAuth(mcpTarget()),
	appAuth: async () => ({ ...(await resourceAuth(appTarget())), ...extraHeaders() })
});

const showUpdate = checkForUpdate();

(async () => {
	try {
		await program.parseAsync();
	} catch (err) {
		console.error(`error: ${formatError(err)}`);
		process.exit(1);
	}
	await showUpdate();
})();
