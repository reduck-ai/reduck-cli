// `reduck flock …` — build a folder into an installable app, and operate the installs.
//
// ONE FOLDER IS AN IMAGE; EVERY INSTALL OF IT IS AN APP. The split is Docker's: the folder is
// built once into an artefact anybody may install, and each install is a running copy with its
// own database, its own blobs and its own secret values. Nothing is copied to make one — a
// release is uploaded once and served to all of them.
//
// "Image" is the word here because this is the builder's tool. Everywhere a person is choosing
// something to run, these are called apps.
//
//   ── the image, which you build ──
//   init              write the folder a deploy expects
//   test              run the folder's offline suite against the host's runtime and test kit
//   deploy            build + upload a release, and serve it to every install
//   images / image    what you have published, and what one of them currently is
//   publish / unpublish                     whether anyone may install it
//   releases / rollback                     what shipped, and back to one of them
//   archive / unarchive                     withdraw it; installs keep running
//
//   ── an app, which is one install ──
//   install           mint one from an image, in a scope you choose
//   apps / open / link                      what you can reach, and which one this folder means
//   sql               the records — one statement, a script, or a prompt
//   db / db:download / db:reset             the database's shape, its bytes, its delete
//   files / files:get / files:put / files:add / files:rm   the corpus
//   config / config:set / config:unset      the app's config document
//   secrets / secrets:set / secrets:page / secrets:unset   the values behind ${VAR}
//   destroy           the app, its blobs, its database
//
// WHO MAY OPEN AN APP is its owning scope and nobody else — its database, blobs and secrets are
// the owner's, so opening one is reading their rows. Sharing the THING is `publish`, and what
// that gets somebody else is an install of their own, which starts empty.
//
// THE OPERATOR READS THE SAME DOORS THE PAGE DOES. `sql` and `files` hand straight
// through to /sql and /file rather than to a parallel admin path, so what a query
// answers here is what the page sees, down to the transaction. What an owner gets
// on top is only what a page must never have: a whole SQL script, a snapshot of
// the bytes, and the delete that rebuilds a database from its migrations.
//
// THE SPLIT BETWEEN config AND secrets is the same one the app folder already makes,
// and it is worth keeping straight: config is the app's own document — the page reads
// and writes them, and they are readable here. A secret is a credential the app was
// GRANTED; the page never sees it, and neither does this CLI once it is set. `secrets`
// therefore lists names and never values, which is not a limitation but the point.
//
// A grant may also list, per host, which secrets a CALL may name (`{"secrets": ["MY_KEY"]}`):
// the call puts `${MY_KEY}` in a header of its own and the door substitutes it. The author
// decides which secrets may travel to a host, the call decides where they go.
//
// A secret also carries ONE bit of policy: whether a browser-triggered request may spend it.
// A task — the app's own server-side code, with no network of its own — may spend every
// secret. A page gets only what `--page` opened, and the default is closed, so the sharpest
// credentials stay out of the tab without anyone having to remember to lock them.
//
// TWO HOSTS ANSWER THESE COMMANDS, and which one is not arbitrary. The Reduck app owns the app
// as a THING — creating it, its name and who may open it, its releases, its secrets — all of
// which are rows about ownership and roles that Reduck already holds; those go through
// @reduck-ai/sdk, so their shapes are the app's own generated types. The flock host owns what
// only it can answer for: the records in its SQLite file, the corpus, the bytes of a release,
// and the config document its /config door writes on every toggle the page makes.
//
// WHERE THE APP ID LIVES: `flock.json`, written into the folder on the first deploy —
// the equivalent of Heroku's git remote. It is about this machine, so the generated
// .gitignore keeps it out of the repository: in another clone, `flock link <uuid>` or
// `--app <uuid>` names the same app, and without either the next deploy creates a new one.
// `--app <uuid>` overrides it. It also records the owning handle, since the app addresses an
// app as (handle, id); a folder linked before that, or a bare `--app`, resolves the handle by
// looking the id up (see appScope).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from "node:fs";
import * as nodeModule from "node:module";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { openBrowser } from "./open.js";
import {
	createReduckClient,
	createApp,
	getApp,
	listAllApps,
	listApps,
	getMe,
	getAppSecrets,
	updateAppSecrets,
	archiveAppImage,
	createAppImage,
	getAppImage,
	listAllAppImages,
	listAppImageReleases,
	listAppImages,
	publishAppImageRelease,
	restoreAppImage,
	rollbackAppImage,
	startAppImageRelease,
	updateAppImage,
	type App,
	type AppImage,
	type AppImageSummary,
	type AppSecret,
	type AppSummary
} from "@reduck-ai/sdk";
import { extraHeaders } from "./extra.js";
import { experimental } from "./experimental.js";

const DEFAULT_FLOCK_URL = "https://flock.reduck.ai";
const DEFAULT_APP_URL = "https://reduck.ai";

// The client runtime (`import … from "flock"`) is fetched from the SERVER being
// deployed to, not shipped in this package: it is the page's half of that server's
// doors, so a page must never be built against a version older than the doors that
// will answer it. WHICH files it is, the server answers too (`/client/manifest.json`)
// — so a module promoted into the runtime reaches every deploy with no CLI release.
// Cached per host+digest under ~/.cache/reduck. The same specifier (`flock`) is
// aliased to the page runtime for front.jsx and to the task runtime for tasks/*.ts,
// which is what lets a shared lib/*.js be imported by both with no conditionals.

// Two credentials, named for the resource each is good at. An access token names the single
// resource it was issued for, so the token flock accepts is not the token the app accepts —
// but both come from the same refresh token, so there is no second sign-in. An API key names
// no resource and serves either.
export interface FlockDeps {
	/** For the flock host, which resolves it by asking Reduck who holds it. */
	mcpAuth: () => Promise<Record<string, string>>;
	/** For the Reduck app: apps, releases, secrets and access are read and written there. */
	appAuth: () => Promise<Record<string, string>>;
}

// An app's own shapes come from @reduck-ai/sdk, generated from the app's OpenAPI spec, so a
// field added there reaches this file as a type error rather than as a silent `undefined`.
// Only what the FLOCK host answers is declared here — it has no spec.

// `manifest.json` — the image's identity and its install contract, authored and COMMITTED.
// Everything here is about the artefact rather than about any one install, which is why it
// belongs in the folder rather than in the generated link beside it.
interface Manifest {
	/** Second half of the address, under the owner's handle. Chosen once and never changed. */
	slug: string;
	name?: string;
	description?: string;
	about?: string;
	/** Every `${VAR}` the grant references, so an install can be asked for it in words. */
	secrets?: Record<
		string,
		{ label?: string; description?: string; required?: boolean; page?: boolean }
	>;
	/** JSON Schema over the config document: the gate `config()` refuses against, the install
	 *  form's fields, and — through its `default` values — what an install starts from. */
	config?: Record<string, unknown>;
	/** The grant: each host the page may reach, and what rides along. One file with the
	 *  `secrets` it spends, so declaration and use are read in one glance. */
	hosts?: Record<string, unknown>;
	/** The task NAMES an agent may call — `["scan"]`. Everything else a tool declaration holds is
	 *  read off the built task's own exports. */
	tools?: string[];
	/** The tasks flock runs on the app's behalf, by the moment that fires each. Task names. */
	hooks?: Partial<Record<HookName, string>>;
	/** The Reduck scripts the app may run, as `[owner/]host/slug` addresses. The `reduck` door
	 *  refuses a run naming any other, so this is the whole of what a viewer's token can be spent
	 *  on from this app. */
	scripts?: string[];
}

// `[owner/]host/slug`, the grammar the flock host accepts, so an address the deploy accepts is one
// the host will recognise. `@user` is a user's script, a bare owner a
// project's (`reduck`), and no owner means the viewer's own.
const SCRIPT_ADDRESS_RE = /^(?:(@?[A-Za-z0-9_.-]+)\/)?([A-Za-z0-9._-]+)\/([A-Za-z0-9_.-]+)$/;

// The two moments only flock can see, and so the only tasks it launches by itself: an app's first
// open and a person's first open. Nothing else is a hook — a page, a shell, a clock and a decision
// all name the task they want.
const HOOK_NAMES = ["init", "newUser"] as const;
type HookName = (typeof HOOK_NAMES)[number];

// One tool an agent may call, assembled at deploy time from the manifest's `tools` and the built
// task's exports. Part of the artefact for the same reason the grant is: what an image can be
// ASKED to do is a property of its code, not of one installation.
interface ToolDeclaration {
	/** The task this calls, as in `tasks/<name>.ts`. Also the name an agent calls it by. */
	task: string;
	/** What it does, in the words an agent chooses it by. */
	description: string;
	/** JSON Schema for the task's arguments. Optional — a task validates its own anyway. */
	inputSchema?: Record<string, unknown>;
	/** JSON Schema for what it returns. */
	outputSchema?: Record<string, unknown>;
}

// `flock.json` — generated, and about THIS machine rather than about the image: which host, which
// scope the image lives in, and which install the app-scoped commands act on. The image's own
// identity is in manifest.json, which is what a colleague needs and what review sees.
//
// The two handles are separate because they genuinely differ: installing somebody else's public
// image into your project leaves the image theirs and the app yours, and each is addressed under
// its own owner.
interface LinkFile {
	host?: string;
	/** The scope the image lives in. Its slug is manifest.json's. */
	handle?: string;
	/** The install `sql`, `files`, `config`, `secrets` and `task` act on. Set by `install`/`link`. */
	app?: { id: string; handle: string };
}

interface SqlResult {
	rows: Record<string, unknown>[];
	columns: string[];
	rowCount: number;
	lastInsertRowid: number | null;
}

interface DbInfo {
	exists: boolean;
	bytes: number;
	tables: { name: string; rows: number }[];
}

interface FileEntry {
	key: string;
	size: number;
	modified: number;
}

/**
 * How a task is going, as `/task/<id>` answers it.
 *
 * `result` is present even when null — a task that returned null said something, so the field that
 * answers "is it done" is `status` and never the presence of a result. `retryAfterMs` rides on the
 * 202, which is why `--wait` needs no cadence of its own.
 */
interface TaskRecord {
	taskId: string;
	task: string;
	status: "running" | "ok" | "error" | "lost";
	startedAt: string | null;
	finishedAt: string | null;
	retryAfterMs?: number;
	result?: unknown;
	error?: string;
	logs?: string[];
}

/** One run in a listing, as `GET /task` answers it. No `logs` and no `result`: fifty of
 *  either is megabytes a listing never shows, so a row carries their SIZE instead —
 *  `logLines` and `hasResult` — and `task:logs` fetches the one the reader asked for,
 *  with `--json` for the half that is not lines. */
interface TaskSummary {
	taskId: string;
	task: string;
	status: "running" | "ok" | "error" | "lost";
	trigger: string;
	cronId: string | null;
	userId: string | null;
	startedAt: string;
	finishedAt: string | null;
	logLines?: number;
	hasResult?: boolean;
	error?: string;
}

/** One schedule, as `/cron` answers it. `lastStatus` and `lastError` are JOINED from the
 *  task the last fire produced rather than stored on the row — including a fire that never
 *  reached the pool, which is why a stopped schedule can say why without a column for it. */
interface CronRow {
	id: string;
	task: string;
	args: Record<string, unknown>;
	schedule: string;
	enabled: boolean;
	createdBy: string;
	nextRunAt: string | null;
	lastRunAt: string | null;
	lastTaskId: string | null;
	lastStatus: string | null;
	lastError: string | null;
	consecutiveFailures: number;
	createdAt: string;
}

const flockTarget = (override?: string): string =>
	(override ?? process.env.REDUCK_FLOCK_URL ?? DEFAULT_FLOCK_URL).replace(/\/+$/, "");

// The Reduck app, which owns the apps themselves: creating one, renaming it, its releases,
// its secrets, who may open it. Exported because index.ts needs the same value to name it as
// the RFC 8707 resource when it mints a token — one issued for the MCP is not one this
// accepts.
export const appTarget = (): string =>
	(process.env.REDUCK_APP_URL ?? DEFAULT_APP_URL).replace(/\/+$/, "");

// ── the control API ─────────────────────────────────────────────────────────

/**
 * `fetch`, with the reason a request never got an answer. fetch collapses every transport failure
 * into "fetch failed" and hides the real one on `cause` — useless for someone staring at a failed
 * deploy. Every request this file makes goes through here, so each one names its host and cause.
 */
async function reach(url: string, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (e) {
		const cause = (e as { cause?: unknown }).cause;
		const detail = cause instanceof Error ? cause.message : cause ? String(cause) : "";
		throw new Error(
			`could not reach ${new URL(url).origin}: ${e instanceof Error ? e.message : String(e)}${detail ? ` (${detail})` : ""}`
		);
	}
}

/**
 * A PUT to a presigned URL, tried again on a dropped connection or a 5xx. The same PUT sent twice
 * writes the same object, so repeating it is safe; a 4xx (an expired or bad signature) is the
 * storage's answer and is returned at once. The waits are 1 s, 2 s, 4 s: a reset from a home
 * connection clears in seconds, and the link stays valid for the whole upload window.
 */
async function put(url: string, init: RequestInit, tries = 4): Promise<Response> {
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await reach(url, init);
			if (res.status < 500 || attempt === tries) return res;
		} catch (e) {
			if (attempt === tries)
				throw new Error(
					`${e instanceof Error ? e.message : String(e)}, after ${tries} attempts`
				);
		}
		await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
	}
}

// How many files a deploy uploads at once. A mid-size app ships about 50 files; with one connection
// each, a connection reset on one of them is likely from a home network.
const UPLOADS_AT_ONCE = 6;

async function call<T>(
	deps: FlockDeps,
	host: string,
	method: string,
	path: string,
	body?: unknown,
	// A status that is an ANSWER rather than a complaint. One route needs it: a task's
	// `/task/<id>` replies 202 while it runs, carrying its own `retryAfterMs` — so the body IS the
	// answer ("not done, come back in 2s") and throwing would discard the pacing the server just gave
	// us. Opt-in per call, because for every other route a non-2xx is a failure and must stay one.
	pending?: number
): Promise<T> {
	const headers = { ...(await deps.mcpAuth()), ...extraHeaders() };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const res = await reach(`${host}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
	}
	if (!res.ok && res.status !== pending) {
		const answer = parsed as { error?: string; partial?: boolean };
		// A failed SCRIPT is the one error where "it failed" is misleading: the
		// statements before the failing one have already landed, so say where to
		// look rather than leaving someone to assume nothing happened.
		const partial = answer.partial
			? " — the statements before it have already landed; run `flock db` to see where it stopped"
			: "";
		throw new Error(`${method} ${path} → ${answer.error ?? res.status}${partial}`);
	}
	return parsed as T;
}

/**
 * An SDK client for the Reduck app, carrying whichever credential this run holds.
 *
 * Built per call rather than once: `appAuth` refreshes an access token on demand, and a client
 * captured at startup would pin the header it happened to mint then.
 */
async function appClient(deps: FlockDeps) {
	return createReduckClient({ baseUrl: appTarget(), headers: await deps.appAuth() });
}

type Answered<T> = { data?: T; error?: unknown; response?: Response };

/**
 * What the SDK returned, or the error it carries. The generated functions resolve rather than
 * throw, so every call site would otherwise repeat this check. The app answers a failed field
 * check as `{error, variables}`, and naming the field beats a bare 400.
 *
 * WHICH HOST REFUSED IS PART OF THE ANSWER. A `flock` command talks to the app, the flock host and
 * the MCP, each with a target of its own, so "Invalid API key" alone cannot say whose key it was —
 * and the host is the one fact that tells a wrong credential from a wrong environment. The
 * response carries it, so it rides along with the server's own words.
 */
function unwrap<T>(result: Answered<T>, what: string): T {
	if (result.data !== undefined) return result.data;
	const answer = (result.error ?? {}) as { error?: string; variables?: Record<string, string[]> };
	const fields = Object.entries(answer.variables ?? {})
		.flatMap(([field, errors]) => errors.map((message) => `${field}: ${message}`))
		.join("; ");
	const where = result.response
		? `${new URL(result.response.url).host} ${result.response.status}`
		: new URL(appTarget()).host;
	throw new Error(
		`${what} → ${where}: ${answer.error ?? "failed"}${fields ? ` (${fields})` : ""}`
	);
}

/**
 * The same, for a LOOKUP: 404 is the one failure that is an answer — "absent" — and every other
 * one is still a failure. Reading `.data` bare made a refused lookup (401, 403, a protection page)
 * look like an absent thing, and a caller that creates what is absent then created it, on whichever
 * host it had been refused by.
 */
function unwrapIfFound<T>(result: Answered<T>, what: string): T | undefined {
	return result.response?.status === 404 ? undefined : unwrap(result, what);
}

/** The same call, for the two doors that carry BYTES rather than JSON. */
async function raw(
	deps: FlockDeps,
	host: string,
	method: string,
	path: string,
	body?: Buffer
): Promise<Buffer> {
	const res = await reach(`${host}${path}`, {
		method,
		headers: { ...(await deps.mcpAuth()), ...extraHeaders() },
		body: body as unknown as RequestInit["body"]
	});
	const data = Buffer.from(await res.arrayBuffer());
	if (!res.ok) {
		let message = data.toString("utf8").slice(0, 300);
		try {
			message = (JSON.parse(message) as { error?: string }).error ?? message;
		} catch {
			// not the JSON envelope; the raw text is the best we have
		}
		throw new Error(`${method} ${path} → ${message}`);
	}
	return data;
}

/**
 * Bytes a door answers with a redirect to storage rather than directly — a database can be larger
 * than the response a serverless function may return.
 *
 * The redirect is followed BY HAND. An automatic follow would carry this CLI's headers to the
 * storage host: fetch drops `Authorization` on a cross-origin hop, but not an `X-API-Key` header. The link is presigned, so the second request needs no credential.
 */
async function download(deps: FlockDeps, host: string, path: string): Promise<Buffer> {
	const res = await reach(`${host}${path}`, {
		headers: { ...(await deps.mcpAuth()), ...extraHeaders() },
		redirect: "manual"
	});
	// A host that has not moved to the redirect yet answers with the bytes themselves.
	if (res.ok) return Buffer.from(await res.arrayBuffer());
	const location = res.headers.get("location");
	if (res.status < 300 || res.status >= 400 || !location) {
		let message = (await res.text()).slice(0, 300);
		try {
			message = (JSON.parse(message) as { error?: string }).error ?? message;
		} catch {
			// not the JSON envelope; the raw text is the best we have
		}
		throw new Error(`GET ${path} → ${res.status}: ${message}`);
	}
	const file = await reach(location);
	if (!file.ok) throw new Error(`downloading the snapshot → ${file.status} ${file.statusText}`);
	return Buffer.from(await file.arrayBuffer());
}

// ── the folder ──────────────────────────────────────────────────────────────

const linkPath = (dir: string): string => join(dir, "flock.json");

function readLink(dir: string): LinkFile {
	const path = linkPath(dir);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as LinkFile;
	} catch {
		return {};
	}
}

function writeLink(dir: string, link: LinkFile): void {
	writeFileSync(linkPath(dir), `${JSON.stringify(link, null, "\t")}\n`);
}

/** The app this command is about: --app wins, then flock.json (for THIS host). */
function resolveApp(dir: string, host: string, override?: string): string {
	if (override) return override;
	const link = readLink(dir);
	// The host is checked because one folder is deployed to staging and, later, to
	// production: silently reusing a staging uuid against another host would answer
	// 404 at best and edit the wrong app at worst.
	if (link.app && (!link.host || link.host === host)) return link.app.id;
	throw new Error(
		`no app linked in ${linkPath(dir)} for ${host} — \`reduck flock install\` mints one, ` +
			"`reduck flock link <uuid>` points at an existing one, or pass --app <uuid>"
	);
}

function readJsonFile(path: string, what: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("not an object");
		return parsed as Record<string, unknown>;
	} catch (e) {
		throw new Error(
			`${what} (${path}) is not a JSON object: ${e instanceof Error ? e.message : e}`
		);
	}
}

/** The image this folder builds. Its slug is the address, so a folder without one is not one. */
function readManifest(dir: string): Manifest {
	const path = join(dir, "manifest.json");
	if (!existsSync(path)) {
		throw new Error(
			`${path} is missing — an image needs a name and a slug to be addressed by.\n` +
				`Write one:  { "slug": "${basename(dir)}", "name": "${basename(dir)}" }`
		);
	}
	const parsed = readJsonFile(path, "the manifest") as unknown as Manifest;
	if (typeof parsed.slug !== "string" || !/^[a-z0-9_-]{1,64}$/.test(parsed.slug)) {
		throw new Error(
			`${path} needs a "slug" of lowercase letters, digits, "-" and "_" — it is the address, ` +
				"and it is chosen once and never changed"
		);
	}
	return parsed;
}

/** `migrations/*.sql`, in the order they apply, which is the order of their names. */
function readMigrations(dir: string): { name: string; body: Buffer }[] {
	const at = join(dir, "migrations");
	if (!existsSync(at)) return [];
	return readdirSync(at)
		.filter((f) => f.endsWith(".sql"))
		.sort()
		.map((f) => ({ name: `migrations/${f}`, body: readFileSync(join(at, f)) }));
}

/** The task names a build holds — one `task.<name>.js` per `tasks/<name>.ts`. */
function builtTasks(built: Record<string, Buffer>): Set<string> {
	return new Set(
		Object.keys(built)
			.filter((name) => name.startsWith("task.") && name.endsWith(".js"))
			.map((name) => name.slice("task.".length, -".js".length))
	);
}

/** Refuse a manifest entry naming a task the build does not hold. A typo would otherwise be a
 *  task flock launches, or an agent calls, and is answered "no such task" by — at the far end. */
function mustBeBuilt(what: string, name: string, tasks: Set<string>): void {
	if (tasks.has(name)) return;
	throw new Error(
		`manifest.json's ${what} names "${name}", and there is no tasks/${name}.ts in this build —\n` +
			`this release ships ${tasks.size ? [...tasks].sort().join(", ") : "no tasks at all"}.`
	);
}

/**
 * The manifest's `tools` — MEMBERSHIP ONLY: `["scan"]`, the task names an agent may call.
 * Everything else a declaration carries (description, input/output schemas) is read off the BUILT
 * BUNDLE's own exports, so the agent surface and the implementation are one statement and cannot
 * drift — the full declarations are assembled here, into the release, which is the fast-parse
 * JSON platforms read.
 */
async function readTools(
	manifest: Manifest,
	built: Record<string, Buffer>
): Promise<ToolDeclaration[]> {
	const declared: unknown = manifest.tools;
	if (declared === undefined) return [];
	if (!Array.isArray(declared) || declared.some((entry) => typeof entry !== "string")) {
		throw new Error(
			`manifest.json's "tools" is a LIST of task NAMES — ["scan"]. The description and the ` +
				`schemas are the task file's own exports, read from the build.`
		);
	}
	const names = declared as string[];
	const seen = new Set<string>();
	const tasks = builtTasks(built);

	// The bundles are imported to read their exports, which is safe: a task bundle's module init
	// touches nothing but an optional global the sandbox installs (`client/task.js`).
	const out = mkdtempSync(join(tmpdir(), "flock-tools-"));
	try {
		const tools: ToolDeclaration[] = [];
		for (const name of names) {
			if (seen.has(name)) throw new Error(`manifest.json's "tools" names "${name}" twice`);
			seen.add(name);
			mustBeBuilt('"tools"', name, tasks);
			const file = join(out, `task.${name}.mjs`);
			writeFileSync(file, built[`task.${name}.js`]);
			const mod = (await importHref(pathToFileURL(file).href)) as {
				description?: unknown;
				input?: unknown;
				output?: unknown;
			};
			if (typeof mod.description !== "string" || !mod.description.trim()) {
				throw new Error(
					`tasks/${name}.ts is offered to agents and exports no "description" — it is ` +
						`what an agent chooses it by`
				);
			}
			tools.push({
				task: name,
				description: mod.description,
				...(isPlainRecord(mod.input) ? { inputSchema: mod.input } : {}),
				...(isPlainRecord(mod.output) ? { outputSchema: mod.output } : {})
			});
		}
		return tools;
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

// `SKILL.md` — how to combine the app's tools for a purpose, in the author's words. An agent reads
// it after the tool declarations, which are injected from the build, so it never restates a
// schema. It ships as a release file: versioned and rolled back with the tasks it names.
const SKILL_FILE = "SKILL.md";
// An agent reads the whole file every time it learns the app.
const SKILL_MAX_BYTES = 64 * 1024;

function readSkill(dir: string): Buffer | null {
	const path = join(dir, SKILL_FILE);
	if (!existsSync(path)) return null;
	const body = readFileSync(path);
	if (body.length > SKILL_MAX_BYTES)
		throw new Error(
			`${SKILL_FILE} is ${body.length} bytes, over the ${SKILL_MAX_BYTES} allowed — an agent ` +
				`reads all of it each time it learns the app. Keep the workflows, drop the reference.`
		);
	return body;
}

/**
 * The manifest's `hooks` — `{"init": "setup", "newUser": "welcome"}`, each a task
 * flock launches by itself at the moment the key names. Every key is optional; a key left out is a
 * moment that runs nothing. A key that is not one of the three is refused rather than ignored,
 * because `"newuser"` would otherwise be a hook nothing ever fires, and nothing would say so.
 */
function readHooks(
	manifest: Manifest,
	built: Record<string, Buffer>
): Partial<Record<HookName, string>> {
	const declared: unknown = manifest.hooks;
	if (declared === undefined) return {};
	if (!isPlainRecord(declared)) {
		throw new Error(
			`manifest.json's "hooks" is an OBJECT from a moment to a task name — ` +
				`{"init": "setup"}. The moments are ${HOOK_NAMES.join(", ")}.`
		);
	}
	const tasks = builtTasks(built);
	const hooks: Partial<Record<HookName, string>> = {};
	for (const [key, value] of Object.entries(declared)) {
		if (!(HOOK_NAMES as readonly string[]).includes(key)) {
			throw new Error(
				`manifest.json's "hooks" has no moment called "${key}" — the moments are ` +
					`${HOOK_NAMES.join(", ")}.`
			);
		}
		if (typeof value !== "string" || !value) {
			throw new Error(`manifest.json's hooks.${key} must name a task, as in tasks/<name>.ts`);
		}
		mustBeBuilt(`hooks.${key}`, value, tasks);
		hooks[key as HookName] = value;
	}
	return hooks;
}

/**
 * The manifest's `scripts` — every Reduck script the app may run, as addresses. Checked for shape
 * here and for existence nowhere: whether a script exists is the MCP's answer at run time, and an
 * address that does not resolve is a run that fails by name rather than a deploy that cannot
 * happen offline.
 */
function readScripts(manifest: Manifest): string[] {
	const declared: unknown = manifest.scripts;
	if (declared === undefined) return [];
	if (!Array.isArray(declared) || declared.some((entry) => typeof entry !== "string")) {
		throw new Error(
			`manifest.json's "scripts" is a LIST of script ADDRESSES — ` +
				`["reduck/x.com/get_personal_feed"]. Every script the app runs has to be in it.`
		);
	}
	const out: string[] = [];
	for (const raw of declared as string[]) {
		const address = raw.trim();
		if (!SCRIPT_ADDRESS_RE.test(address)) {
			throw new Error(
				`manifest.json's "scripts" has ${JSON.stringify(raw)}, which is not a script address — ` +
					`write [owner/]host/slug: "reduck/x.com/get_personal_feed", "@user/host/slug", or ` +
					`"host/slug" for the viewer's own.`
			);
		}
		if (out.includes(address))
			throw new Error(`manifest.json's "scripts" names "${address}" twice`);
		out.push(address);
	}
	return out;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// Indirected so the bundler leaves it alone: the target is a temp file minted at deploy time,
// not a module to resolve at build time, and rollup refuses a dynamic import it cannot analyze.
const importHref = new Function("href", "return import(href)") as (
	href: string
) => Promise<unknown>;

/**
 * What an install starts from: the `default` values of the manifest's config schema, as one
 * document. One declaration — the schema — carries the shape, the form, the gate AND the
 * starting values, so none of them can disagree.
 */
export function extractDefaults(
	schema: Record<string, unknown> | undefined
): Record<string, unknown> {
	const properties = (schema as { properties?: Record<string, unknown> } | undefined)?.properties;
	if (!isPlainRecord(properties)) return {};
	const out: Record<string, unknown> = {};
	for (const [key, sub] of Object.entries(properties)) {
		if (!isPlainRecord(sub)) continue;
		if ("default" in sub) out[key] = sub.default;
		else if (sub.type === "object") {
			const nested = extractDefaults(sub);
			if (Object.keys(nested).length) out[key] = nested;
		}
	}
	return out;
}

// ── what a deploy refuses ───────────────────────────────────────────────────
//
// Both checks exist because the two files they compare are authored separately and drift
// silently. Neither failure shows up until an app is already installed somewhere.

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Every `${VAR}` the grant spends must be declared in the manifest, and vice versa.
 *
 * The grant decides where a secret may travel; the manifest is what an install is ASKED for. A
 * name in one and not the other means either a credential nobody will ever be prompted for, or a
 * prompt for something the app cannot use.
 */
function checkSecretsDeclared(grant: Record<string, unknown>, manifest: Manifest): void {
	const used = new Set<string>();
	for (const match of JSON.stringify(grant).matchAll(ENV_REF)) used.add(match[1]);
	// A grant may also list, per host, which secrets a CALL may name — those are spent too.
	for (const entry of Object.values(grant)) {
		const listed = (entry as { secrets?: unknown })?.secrets;
		if (Array.isArray(listed)) for (const name of listed) used.add(String(name));
	}
	const declared = new Set(Object.keys(manifest.secrets ?? {}));

	const undeclared = [...used].filter((name) => !declared.has(name)).sort();
	const unused = [...declared].filter((name) => !used.has(name)).sort();
	if (undeclared.length) {
		throw new Error(
			`manifest.json's hosts spend ${undeclared.join(", ")}, which its secrets do not declare —\n` +
				`nobody installing this will be asked for ${undeclared.length > 1 ? "them" : "it"}. ` +
				`Add ${undeclared.map((n) => `"${n}": {}`).join(", ")} under "secrets".`
		);
	}
	if (unused.length) {
		throw new Error(
			`manifest.json declares ${unused.join(", ")}, which its hosts never use —\n` +
				"an install would be asked for a credential the app cannot spend."
		);
	}
}

// ── the build ───────────────────────────────────────────────────────────────

/** Every `node_modules` from `dir` up to the filesystem root, nearest first. */
function nodeModulesUpward(dir: string): string[] {
	const found: string[] = [];
	let at = resolve(dir);
	for (;;) {
		const candidate = join(at, "node_modules");
		if (existsSync(candidate)) found.push(candidate);
		const up = dirname(at);
		if (up === at) return found;
		at = up;
	}
}

// THE TOOLCHAIN LIVES ABOVE THE APP, and that is the normal case rather than the
// exception: a flock app folder is four authored files, and react/esbuild sit in the
// checkout that holds every app (e.g. `apps/node_modules`, one level up from `apps/my-app`).
// Looking only in the app folder and the working directory finds nothing there and
// then tells the author to npm-install INTO their app — the one thing the format
// exists to avoid. So walk up, the way node and esbuild themselves resolve.
function findEsbuild(dir: string, override?: string): string {
	if (override) {
		if (existsSync(override)) return override;
		throw new Error(`--esbuild ${override}: no such file`);
	}
	const searched = [...nodeModulesUpward(dir), ...nodeModulesUpward(process.cwd())];
	for (const modules of searched) {
		const candidate = join(modules, ".bin", "esbuild");
		if (existsSync(candidate)) return candidate;
	}
	// PATH last: a project-local esbuild is the one whose version the app was
	// written against.
	const which = spawnSync(process.platform === "win32" ? "where" : "which", ["esbuild"], {
		encoding: "utf8"
	});
	const found = which.stdout?.split("\n")[0]?.trim();
	if (found) return found;
	throw new Error(
		`no esbuild found in or above ${dir}, nor on the PATH.\n` +
			`An app builds with the toolchain of the checkout it lives in — install it once\n` +
			`beside the apps (\`npm install esbuild react react-dom\` in the folder that holds\n` +
			`them), or point at one with --esbuild <path>.`
	);
}

/** The nearest `node_modules` above the app — where its react and its esbuild live, and
 *  where every bare import in its bundle resolves from. */
function toolchainOf(dir: string): string {
	const [found] = [...nodeModulesUpward(dir), ...nodeModulesUpward(process.cwd())];
	if (found) return found;
	throw new Error(
		`no node_modules in or above ${dir} — install the toolchain once beside the apps\n` +
			`(\`npm install esbuild react react-dom\` in the folder that holds them).`
	);
}

/** The server's own client runtime, cached by its digest INSIDE the app's toolchain. The
 *  file list is the server's too (`/client/manifest.json`), so a module promoted into the
 *  runtime needs no CLI release to reach a deploy.
 *
 *  UNDER THE APP'S OWN `node_modules/.cache` AND NOWHERE ELSE. The runtime holds bare imports
 *  of its own (`router.js` imports react), and esbuild resolves those by walking up from the
 *  FILE, not from the app — `NODE_PATH` is consulted only once that walk finds nothing. A
 *  cache anywhere else (the home directory, a temp dir) walks a different tree, and any
 *  `node_modules/react` on the way makes the page carry two Reacts; every hook then dies
 *  with `Cannot read properties of null (reading 'useSyncExternalStore')`. From here the walk reaches the app's toolchain
 *  first, so the runtime and the page resolve every package from one place by construction. */
async function fetchClient(host: string, toolchain: string): Promise<string> {
	const listed = await reach(`${host}/client/manifest.json`, { headers: extraHeaders() });
	if (!listed.ok)
		throw new Error(
			`GET ${host}/client/manifest.json → ${listed.status} (is this a flock host?)`
		);
	const files = ((await listed.json()) as { files?: string[] }).files ?? [];
	if (!files.includes("index.js"))
		throw new Error(`${host}/client/manifest.json lists no index.js — not a flock runtime`);

	const sources: Record<string, string> = {};
	for (const name of files) {
		const res = await reach(`${host}/client/${name}`, { headers: extraHeaders() });
		if (!res.ok) throw new Error(`GET ${host}/client/${name} → ${res.status}`);
		sources[name] = await res.text();
	}
	const digest = createHash("sha256")
		.update(files.map((n) => `${n}\0${sources[n]}`).join("\0"))
		.digest("hex")
		.slice(0, 16);
	const dir = join(toolchain, ".cache", "flock-client", digest);
	if (!existsSync(join(dir, "index.js"))) {
		mkdirSync(dir, { recursive: true });
		for (const name of files) writeFileSync(join(dir, name), sources[name]);
	}
	return join(dir, "index.js");
}

interface Built {
	files: Record<string, Buffer>;
	ms: number;
}

async function build(
	dir: string,
	host: string,
	opts: { esbuild?: string; minify?: boolean }
): Promise<Built> {
	const front = join(dir, "front.jsx");
	if (!existsSync(front)) throw new Error(`${front} is missing — an app is its page`);
	const esbuild = findEsbuild(dir, opts.esbuild);
	const client = await fetchClient(host, toolchainOf(dir));
	// esbuild resolves react — and any npm package an app imports — by walking up from the
	// source file, which finds the checkout's node_modules on its own. This is the fallback
	// for an app folder that has been COPIED somewhere else: every node_modules above the app, nearest first, rather than one that may not
	// exist. Shared by both passes, so a dependency an app installed is available to its
	// page and to its tasks alike.
	const nodePath = [...nodeModulesUpward(dir), ...nodeModulesUpward(process.cwd())].join(
		process.platform === "win32" ? ";" : ":"
	);
	const out = mkdtempSync(join(tmpdir(), "flock-build-"));
	const started = Date.now();
	try {
		const proc = spawnSync(
			esbuild,
			[
				front,
				"--bundle",
				`--outdir=${out}`,
				"--entry-names=app",
				"--format=esm",
				"--target=es2022",
				"--jsx=automatic",
				"--sourcemap",
				"--log-level=warning",
				'--define:process.env.NODE_ENV="production"',
				...(opts.minify ? ["--minify"] : []),
				// `flock` resolves to the SERVER's client runtime, and react resolves
				// from the app folder — so an app folder builds identically wherever it
				// sits, exactly as it does under the local server.
				`--alias:flock=${client}`,
				// The React router is its own specifier so that an app which does not
				// import it does not carry React's copy of it.
				`--alias:flock/router=${join(dirname(client), "router.js")}`
			],
			{
				encoding: "utf8",
				env: { ...process.env, NODE_PATH: nodePath }
			}
		);
		if (proc.stderr?.trim()) console.error(proc.stderr.trim());
		if (proc.status !== 0) throw new Error("esbuild refused front.jsx (see above)");
		const files: Record<string, Buffer> = {};
		for (const name of readdirSync(out)) files[name] = readFileSync(join(out, name));
		for (const [name, code] of Object.entries(buildTasks(dir, esbuild, client, nodePath))) {
			files[name] = code;
		}
		return { files, ms: Date.now() - started };
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

/** The app's server-side half: one ESM bundle per `tasks/*.ts`, deps inlined.
 *
 *  The SAME specifier, aliased differently. `front.jsx` builds with `flock` → the page
 *  runtime; a task builds with `flock` → the task runtime. That is the whole mechanism
 *  behind shared code: an app puts logic in `lib/*.js`, imports it from both sides with no
 *  conditionals, and esbuild inlines it into each bundle against whichever half is
 *  building.
 *
 *  `flock/router` is deliberately NOT aliased here, so importing React routing into a task
 *  is a build-time error rather than something that fails in a sandbox with no DOM.
 */
function buildTasks(
	dir: string,
	esbuild: string,
	client: string,
	nodePath: string
): Record<string, Buffer> {
	const tasksDir = join(dir, "tasks");
	if (!existsSync(tasksDir)) return {};
	const sources = readdirSync(tasksDir).filter((f) => /\.[cm]?[jt]sx?$/.test(f));
	if (!sources.length) return {};

	const out = mkdtempSync(join(tmpdir(), "flock-tasks-"));
	try {
		const built: Record<string, Buffer> = {};
		for (const source of sources) {
			const name = source.replace(/\.[cm]?[jt]sx?$/, "");
			// A release file name may not contain "/", and the server addresses a task as
			// `task.<name>.js` — so the name has to survive being a path segment too.
			if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
				throw new Error(
					`tasks/${source}: not a usable task name — use letters, digits, "-" and "_"`
				);
			}
			// Caught here rather than left to esbuild, which reports it as a resolve error
			// about a directory — true, but it names our cache path instead of the mistake.
			// `flock/router` is React routing: it needs a DOM and a URL, and a task has
			// neither, so this is a wrong import rather than a missing capability.
			const text = readFileSync(join(tasksDir, source), "utf8");
			if (/["']flock\/router["']/.test(text)) {
				throw new Error(
					`tasks/${source} imports "flock/router", which is React routing for the page —\n` +
						`a task runs in a sandbox with no DOM and no URL. Move that part into front.jsx.`
				);
			}
			const file = join(out, `${name}.js`);
			const proc = spawnSync(
				esbuild,
				[
					join(tasksDir, source),
					"--bundle",
					`--outfile=${file}`,
					"--format=esm",
					// browser, not node: the sandbox has no filesystem, no network of its own and
					// no node builtins. Resolving the browser/import conditions keeps a package
					// that reaches for `fs` out at bundle time rather than at first call.
					"--platform=browser",
					"--target=es2022",
					// Inline, so a throw inside a task reports the AUTHOR's file and line. Without
					// it a stack points into bundled output, which is the difference between a
					// debuggable task and a puzzle.
					"--sourcemap=inline",
					"--log-level=warning",
					`--alias:flock=${join(dirname(client), "task.js")}`
				],
				{ encoding: "utf8", env: { ...process.env, NODE_PATH: nodePath } }
			);
			if (proc.stderr?.trim()) console.error(proc.stderr.trim());
			if (proc.status !== 0) throw new Error(`esbuild refused tasks/${source} (see above)`);
			built[`task.${name}.js`] = readFileSync(file);
		}
		return built;
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

// ── the offline suite ───────────────────────────────────────────────────────

/** The served file each bare `flock` specifier of a test resolves to. `flock` is the page
 *  runtime, the file `node_modules/flock` resolves to in a checkout that links the client
 *  package, so a suite written there runs here unchanged. `flock/harness` is an older name for
 *  `flock/testing`, kept for suites that still import it. */
const SUITE_SPECIFIERS: Record<string, string> = {
	flock: "index.js",
	"flock/router": "router.js",
	"flock/testing": "harness.mjs",
	"flock/harness": "harness.mjs"
};

/** The module `node --import` loads ahead of the suite. It runs in every test process, so each
 *  file's `flock` imports reach the copy cached in the app's toolchain, where `react` resolves
 *  from the same place it does in a build. */
const suiteHooks = (clientDir: string): string => {
	const to = Object.fromEntries(
		Object.entries(SUITE_SPECIFIERS).map(([specifier, file]) => [
			specifier,
			pathToFileURL(join(clientDir, file)).href
		])
	);
	return `import { registerHooks } from "node:module";
const to = ${JSON.stringify(to)};
registerHooks({
	resolve: (specifier, context, nextResolve) =>
		Object.hasOwn(to, specifier)
			? { url: to[specifier], shortCircuit: true }
			: nextResolve(specifier, context)
});
`;
};

async function testCmd(dir: string | undefined, opts: { host?: string }): Promise<void> {
	const folder = resolve(dir ?? ".");
	if (!existsSync(folder)) throw new Error(`${folder}: no such folder`);
	// Node 22 has `registerHooks` only from one of its minor releases on. The kit needs Node 24.15
	// anyway (it says so when it opens a database), so that is the version to ask for.
	if (typeof (nodeModule as { registerHooks?: unknown }).registerHooks !== "function") {
		throw new Error(
			`Node ${process.versions.node} cannot point the suite's "flock" imports at the host's files: it has no module.registerHooks.\n` +
				"Use Node 24.15 or later. flock/testing needs it too."
		);
	}
	const host = flockTarget(opts.host);
	const clientDir = dirname(await fetchClient(host, toolchainOf(folder)));
	if (!existsSync(join(clientDir, SUITE_SPECIFIERS["flock/testing"]))) {
		throw new Error(
			`${host} serves no test kit: its /client/manifest.json does not list harness.mjs.`
		);
	}
	const hooks = mkdtempSync(join(tmpdir(), "flock-test-"));
	try {
		const file = join(hooks, "hooks.mjs");
		writeFileSync(file, suiteHooks(clientDir));
		// A runner started from inside another test runner's process inherits NODE_TEST_CONTEXT and
		// reports to that runner instead of running as a suite of its own, and a failing test
		// then leaves the exit status at 0. This suite is always the top-level one.
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		// No files named: node finds the suite with its own patterns (`*.test.mjs` and the rest),
		// so a helper module beside the tests is imported by them and never run on its own.
		const proc = spawnSync(process.execPath, ["--import", pathToFileURL(file).href, "--test"], {
			cwd: folder,
			stdio: "inherit",
			env
		});
		if (proc.error) throw proc.error;
		// node has printed the report; the exit status is the verdict.
		process.exitCode = proc.status ?? 1;
	} finally {
		rmSync(hooks, { recursive: true, force: true });
	}
}

// ── the records, at a prompt ────────────────────────────────────────────────
//
// The page reads this database through /sql and so does this; the difference is
// only who is asking. What an operator gets that a page does not: a whole SQL
// script (`--file`), a look at the shape (`db`), the bytes (`db:download`), and
// the delete that rebuilds a database from its migrations (`db:reset`).

const CELL_MAX = 60;

const cell = (value: unknown): string => {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "object") return JSON.stringify(value);
	const text = String(value).replace(/\n/g, "⏎");
	return text.length > CELL_MAX ? `${text.slice(0, CELL_MAX - 1)}…` : text;
};

const humanBytes = (n: number): string =>
	n < 1024
		? `${n} B`
		: n < 1024 * 1024
			? `${Math.round(n / 1024)} KB`
			: `${(n / 1048576).toFixed(1)} MB`;

/** A result set as a padded table — or, with --json, exactly what the door said. */
function printResult(result: SqlResult, asJson: boolean): void {
	if (asJson) {
		console.log(JSON.stringify(result.rows ?? [], null, 2));
		return;
	}
	// A write has no columns. Its counters ARE the answer, so print those instead
	// of an empty table, which reads like "nothing happened".
	if (!result.columns?.length) {
		console.log(
			`ok — ${result.rowCount} row(s) affected${
				result.lastInsertRowid ? `, last id ${result.lastInsertRowid}` : ""
			}`
		);
		return;
	}
	const rows = result.rows ?? [];
	const widths = result.columns.map((column, i) =>
		Math.max(column.length, ...rows.map((row) => cell(row[result.columns[i]]).length), 0)
	);
	const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
	console.log(line(result.columns));
	console.log(widths.map((w) => "─".repeat(w)).join("  "));
	for (const row of rows) console.log(line(result.columns.map((c) => cell(row[c]))));
	console.log(`(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

const runStatement = (
	deps: FlockDeps,
	host: string,
	appId: string,
	payload: Record<string, unknown>
): Promise<SqlResult> => call<SqlResult>(deps, host, "POST", `/api/apps/${appId}/sql`, payload);

/** `flock sql` with nothing to run: a prompt, one statement at a time. */
async function repl(deps: FlockDeps, host: string, appId: string, asJson: boolean): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "sql> " });
	console.error(
		`Connected to ${host}/app/${appId}. .tables lists them, .exit leaves, ; ends a statement.`
	);
	// Statements are accumulated until a `;` closes one, so a long query can be
	// pasted across lines the way it is written in a file.
	let buffer = "";
	rl.prompt();
	for await (const line of rl) {
		const text = line.trim();
		if (!buffer && (text === ".exit" || text === ".quit")) break;
		if (!buffer && (text === ".tables" || text === ".schema")) {
			const info = await call<DbInfo>(deps, host, "GET", `/api/apps/${appId}/db`);
			for (const table of info.tables) console.log(`${table.name}\t${table.rows} row(s)`);
			rl.prompt();
			continue;
		}
		if (!buffer && text === ".help") {
			console.log(".tables  .exit  — anything else is SQL, ended with ;");
			rl.prompt();
			continue;
		}
		buffer = buffer ? `${buffer}\n${line}` : line;
		if (!buffer.trim().endsWith(";")) {
			rl.setPrompt("  …> ");
			rl.prompt();
			continue;
		}
		const statement = buffer.trim().replace(/;$/, "");
		buffer = "";
		rl.setPrompt("sql> ");
		if (statement)
			try {
				printResult(
					await runStatement(deps, host, appId, { sql: statement, params: [] }),
					asJson
				);
			} catch (e) {
				console.error(e instanceof Error ? e.message : String(e));
			}
		rl.prompt();
	}
	rl.close();
}

/** Everything on stdin, when it is a pipe rather than a terminal. */
async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

// ── commands ────────────────────────────────────────────────────────────────

// One line per secret, name and reach. The flag is spelled out on every line rather than shown
// only where it is set: task-only is the default, and someone scanning for what a browser can
// reach should not have to know that absence means closed.
function printSecrets(secrets: AppSecret[]): string {
	return (
		secrets.map((s) => `${s.name}\t${s.page_usable ? "page+task" : "task-only"}`).join("\n") ||
		"(none)"
	);
}

// The URL is built here rather than read off the app: the app row says nothing about WHICH
// flock serves it, and this command already knows which one it is talking to.
function printApp(app: AppSummary, host: string): void {
	const image = app.image ? `${app.image.handle}/${app.image.slug}` : "(image gone)";
	console.log(
		`${app.id}  ${app.name.padEnd(24)} ${app.owner.handle.padEnd(20)} ${image.padEnd(28)} ${
			app.current_release ? `v${app.current_release}` : "nothing deployed"
		}  ${host}/app/${app.id}`
	);
}

// ── the scaffold ────────────────────────────────────────────────────────────────────────────────

/** A folder name as a slug: the address rules, applied to whatever the directory is called. */
function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "app";
}

/**
 * The smallest folder a deploy accepts, and a page that already reads and writes its own records.
 *
 * A worked example rather than empty files: the thing worth showing is that `sql` and `run` go to
 * THIS install's database, so two installs of one image never see each other's rows — which is the
 * whole point of the split and the part a blank front.jsx would leave unsaid.
 */
function scaffold(slug: string, name: string): Record<string, string> {
	return {
		// The whole install contract, one file: identity, the config schema (the gate, the form
		// and — through `default` values — what an install starts from), the secrets, the hosts.
		"manifest.json":
			JSON.stringify(
				{
					slug,
					name,
					description: "",
					about: "",
					config: { type: "object", properties: {} },
					secrets: {},
					hosts: {}
				},
				null,
				"\t"
			) + "\n",

		"migrations/001-initial.sql": `-- The tables. migrations/ is the app's whole DDL: every install — fresh or year-old — climbs
-- these files in name order, from empty, so a day-one database and an updated one are the same
-- SQL by construction. A change is a NEW file beside this one, named so it sorts after it.

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,

		"front.jsx": `// The page. One file, bundled at deploy time, served to every install of this image.
//
// \`sql\` and \`run\` reach THIS install's database and no other: two people who install the same
// image never see each other's rows. \`viewer\` is whoever is looking, already signed in to Reduck.
//
// NO REACT HERE, so this folder deploys with nothing installed. React is the usual way to write a
// flock page and the bundler resolves it from the checkout this folder sits in — add it, import it,
// and the file extension is already right.

import { run, sql, viewer } from "flock";

const el = (tag, props = {}, ...children) => {
	const node = Object.assign(document.createElement(tag), props);
	node.append(...children);
	return node;
};

const list = el("ul");
const input = el("input", { placeholder: "Write something", style: "flex:1;padding:8px" });
const status = el("p", { style: "color:crimson" });

async function refresh() {
	const notes = await sql("SELECT id, body FROM notes ORDER BY id DESC");
	list.replaceChildren(...notes.map((note) => el("li", {}, note.body)));
}

const form = el("form", { style: "display:flex;gap:8px" }, input, el("button", {}, "Add"));
form.onsubmit = async (event) => {
	event.preventDefault();
	const body = input.value.trim();
	if (!body) return;
	input.value = "";
	// Positional params, never string concatenation: this text came from a human, and a quote in
	// it is a syntax error at best.
	await run("INSERT INTO notes (body) VALUES (?)", [body]);
	await refresh();
};

document.body.style.font = "15px ui-sans-serif, system-ui, sans-serif";
document.body.append(
	el("main", { style: "margin:40px auto;max-width:640px" },
		el("h1", {}, ${JSON.stringify(name)}),
		el("p", { style: "color:#666" }, \`Signed in as \${viewer?.email ?? "nobody"}\`),
		form,
		status,
		list
	)
);

refresh().catch((e) => (status.textContent = e.message ?? String(e)));
`,

		".gitignore": `# Generated on the first deploy, and about THIS machine rather than about the image:
# which host, and which install this folder is linked to.
flock.json
`
	};
}

/**
 * Write the folder a deploy expects, and say what to do with it.
 *
 * Refuses to write over anything: a scaffold that overwrites is a scaffold that can eat the page
 * somebody spent an afternoon on, and the recovery ("which files did it touch?") is worse than
 * being told to pick an empty directory.
 */
function initCmd(dirArg: string | undefined, opts: { slug?: string; name?: string }): void {
	const dir = resolve(dirArg ?? ".");
	const slug = opts.slug ?? slugify(basename(dir));
	if (!/^[a-z0-9_-]{1,64}$/.test(slug)) {
		throw new Error(
			`"${slug}" cannot be a slug — lowercase letters, digits, "-" and "_", up to 64 of them. ` +
				"Pass --slug to choose one."
		);
	}
	const name = opts.name ?? basename(dir);
	const files = scaffold(slug, name);

	const clashes = Object.keys(files).filter((f) => existsSync(join(dir, f)));
	if (clashes.length) {
		throw new Error(
			`${dir} already has ${clashes.join(", ")} — nothing was written.\n` +
				"Point init at an empty folder, or delete those first."
		);
	}

	mkdirSync(dir, { recursive: true });
	for (const [file, body] of Object.entries(files)) {
		const at = join(dir, file);
		mkdirSync(dirname(at), { recursive: true });
		writeFileSync(at, body);
	}

	console.log(`${slug} — ${Object.keys(files).length} files in ${dir}`);
	console.log("");

	// Asked of findEsbuild rather than of a search written here, so what init promises and what
	// deploy will actually accept cannot drift apart: it is the same function that decides.
	let toolchain = true;
	try {
		findEsbuild(dir);
	} catch {
		toolchain = false;
	}
	if (!toolchain) {
		console.log("  The bundler is not in or above this folder yet:");
		console.log("    npm install esbuild");
		console.log("");
	}

	console.log("  reduck flock deploy      build it and ship the first release");
	console.log(`  reduck flock install ${slug}   mint an app from it, with its own records`);
}

/**
 * Build the folder and ship it as a release of its image.
 *
 * THE BYTES DO NOT GO THROUGH THE API. A serverless request body caps out well below a bundle,
 * so a deploy is three steps with an upload in the middle: reserve the number and get a presigned
 * PUT per file, upload straight to storage, then ask for it to be published. Nothing serves the
 * release until that last call, so an upload that dies halfway burns a number and breaks nothing.
 *
 * Publishing is also the promote. One deploy, one step: what ships reaches every install of this
 * image on its next load.
 */
async function deployCmd(
	deps: FlockDeps,
	dirArg: string | undefined,
	opts: { project?: string; host?: string; esbuild?: string; minify?: boolean }
): Promise<void> {
	const dir = resolve(dirArg ?? ".");
	const host = flockTarget(opts.host);
	const link = readLink(dir);
	const manifest = readManifest(dir);

	// BUILD AND CHECK BEFORE CREATING ANYTHING. A first deploy that fails must leave nothing
	// behind — an image minted before the build strands an empty one in the account, and the next
	// attempt strands another.
	const built = await build(dir, host, opts);
	console.error(
		`Built ${Object.keys(built.files).join(", ")} in ${built.ms}ms (${Math.round(
			(built.files["app.js"]?.length ?? 0) / 1024
		)} KB)`
	);

	const grant = manifest.hosts ?? {};
	checkSecretsDeclared(grant, manifest);
	const tools = await readTools(manifest, built.files);
	const hooks = readHooks(manifest, built.files);
	const scripts = readScripts(manifest);

	const migrations = readMigrations(dir);
	if (!migrations.length)
		console.error(
			"warning: no migrations/ — the app's database cannot be opened until a release ships some"
		);

	// Everything this release ships, as one flat set of names.
	const files: Record<string, Buffer> = { ...built.files };
	for (const m of migrations) files[m.name] = m.body;
	const skill = readSkill(dir);
	if (skill) files[SKILL_FILE] = skill;

	// The image exists only once there is something to put in it. `--project` picks the owning
	// scope and only ever at creation: an image already belongs somewhere, and its handle is half
	// its address, so moving it is not what a deploy does.
	const client = await appClient(deps);
	const handle =
		(link.host && link.host !== host ? undefined : link.handle) ??
		opts.project ??
		(await callerHandle(deps));
	let image = unwrapIfFound(
		await getAppImage({ client, path: { handle, slug: manifest.slug } }),
		`reading ${handle}/${manifest.slug}`
	);
	// The two lines that report a write name the host it landed on, for the reason `unwrap` does.
	const on = new URL(appTarget()).host;
	if (!image) {
		image = unwrap(
			await createAppImage({
				client,
				path: { handle },
				body: {
					slug: manifest.slug,
					name: manifest.name ?? manifest.slug,
					description: manifest.description,
					about: manifest.about
				}
			}),
			`creating ${handle}/${manifest.slug}`
		);
		console.error(`Created image ${image.owner.handle}/${image.slug} on ${on}`);
	}

	const started = unwrap(
		await startAppImageRelease({
			client,
			path: { handle, slug: manifest.slug },
			body: {
				files: Object.entries(files).map(([name, data]) => ({
					name,
					size: data.length,
					sha256: createHash("sha256").update(data).digest("hex")
				})),
				// The grant travels with the code because it is part of the artefact: the hosts a
				// page may reach are a property of the page, not of one installation. The VALUES
				// behind its ${VAR}s are not here — they are set per install.
				grant,
				// What an install starts from: the schema's own `default` values. A later release
				// adds new config without resetting what a human tuned.
				config: extractDefaults(manifest.config),
				// The stored key is `settings` — the server schema's name for this slot, kept so the
				// wire and every stored row stay untouched. `config` is the AUTHORED name only.
				manifest: { secrets: manifest.secrets, settings: manifest.config, hooks, scripts },
				// Which tasks an agent may call — assembled from the bundles' own exports, so the
				// declaration platforms fast-parse is the implementation's.
				tools,
				migrations: migrations.map((m) => ({
					name: m.name,
					sha: createHash("sha256").update(m.body).digest("hex")
				}))
			}
		}),
		`starting a release of ${handle}/${manifest.slug}`
	);

	// A few workers drain one queue, so at most UPLOADS_AT_ONCE connections are open, and each file
	// is retried on its own (`put`) before the release is given up.
	const queue = [...started.uploads];
	const reserved = `v${started.number} was reserved and is not serving anything; deploy again.`;
	await Promise.all(
		Array.from({ length: Math.min(UPLOADS_AT_ONCE, queue.length) }, async () => {
			for (let upload = queue.shift(); upload; upload = queue.shift()) {
				const { name } = upload;
				const res = await put(upload.url, {
					method: "PUT",
					headers: upload.headers,
					body: files[name] as unknown as RequestInit["body"]
				}).catch((e: Error) => {
					throw new Error(`uploading ${name}: ${e.message}. ${reserved}`);
				});
				if (!res.ok)
					throw new Error(
						`uploading ${name} → ${res.status} ${res.statusText}. ${reserved}`
					);
			}
		})
	);

	const published = unwrap(
		await publishAppImageRelease({
			client,
			path: { handle, slug: manifest.slug, release_number: started.number }
		}),
		`publishing v${started.number}`
	);

	writeLink(dir, { host, handle, ...(link.app ? { app: link.app } : {}) });
	console.error(
		`Deployed ${handle}/${manifest.slug} v${published.current_release} on ${on}` +
			(published.install_count
				? ` — ${published.install_count} install(s) pick it up on their next load`
				: " — nothing installed from it yet, `reduck flock install` mints one")
	);
	console.log(`${handle}/${manifest.slug}`);
}

/** Mint an app from an image, in whichever scope was asked for. */
async function installCmd(
	deps: FlockDeps,
	ref: string,
	opts: {
		dir?: string;
		project?: string;
		name?: string;
		host?: string;
		set?: string[];
		secret?: string[];
	}
): Promise<void> {
	const parts = ref.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		throw new Error(`not an image: ${ref} — it is "@username/slug" or "project-slug/slug"`);
	}
	const [imageHandle, slug] = parts;

	const client = await appClient(deps);
	const into = opts.project ?? (await callerHandle(deps));
	const app = unwrap(
		await createApp({
			client,
			path: { handle: into },
			body: {
				image: { handle: imageHandle, slug },
				...(opts.name ? { name: opts.name } : {}),
				...(opts.set?.length ? { config: nestPairs(parsePairs(opts.set, "--set")) } : {}),
				...(opts.secret?.length ? { secrets: parsePairs(opts.secret, "--secret") } : {})
			}
		}),
		`installing ${ref} into ${into}`
	);

	const host = flockTarget(opts.host);
	// Linked here so the app-scoped commands know which install they are about, without a uuid
	// having to be typed at each of them.
	const dir = resolve(opts.dir ?? ".");
	writeLink(dir, {
		...readLink(dir),
		host,
		app: { id: app.id, handle: app.owner.handle }
	});
	console.error(`Installed ${ref} as ${app.name} in ${app.owner.handle}`);
	console.log(`${host}/app/${app.id}`);
}

async function withApp<T>(
	dirArg: string | undefined,
	opts: { app?: string; host?: string },
	fn: (host: string, appId: string) => Promise<T>
): Promise<T> {
	const dir = resolve(dirArg ?? ".");
	const host = flockTarget(opts.host);
	return fn(host, resolveApp(dir, host, opts.app));
}

/**
 * The caller's own handle, for the endpoints that take a scope rather than an app.
 *
 * There is no "my scope" alias to address, so creating an app in your own account means
 * naming it. An account without a handle cannot own one, and says so here rather than at a
 * 404 two calls later.
 */
async function callerHandle(deps: FlockDeps): Promise<string> {
	const me = unwrap(await getMe({ client: await appClient(deps) }), "reading your account");
	if (!me.handle)
		throw new Error(
			"your account has no handle yet — pick one in Reduck, or deploy into a project with --project <slug>"
		);
	return me.handle;
}

/**
 * The (handle, id) pair the app's own endpoints are addressed by.
 *
 * flock.json records the scope an install was minted in, but one reached with a bare
 * `--app <uuid>` has only the id. That case is answered by asking for the apps this account can
 * reach and finding the id among them, which is also the only honest answer: an id is not
 * addressable on its own, and guessing a scope would 404.
 */
async function appScope<T>(
	deps: FlockDeps,
	dirArg: string | undefined,
	opts: { app?: string; host?: string },
	fn: (handle: string, appId: string) => Promise<T>
): Promise<T> {
	const dir = resolve(dirArg ?? ".");
	const host = flockTarget(opts.host);
	const appId = resolveApp(dir, host, opts.app);

	const link = readLink(dir);
	if (!opts.app && link.app?.id === appId) return fn(link.app.handle, appId);

	const client = await appClient(deps);
	const page = unwrap(
		await listAllApps({ client, query: { page_size: 100 } }),
		"listing your apps"
	);
	const found = page.data.find((a) => a.id === appId);
	if (!found)
		throw new Error(
			`app ${appId} is not one you can reach — check the id, or run \`reduck login\``
		);
	return fn(found.owner.handle, appId);
}

/**
 * The (handle, slug) pair an image is addressed by: the slug from manifest.json, which is the
 * committed half, and the scope from flock.json, which is the machine's.
 *
 * A folder that has never been deployed has no scope recorded, so the caller's own is assumed —
 * the same assumption `deploy` makes, and wrong in exactly the one case `--project` exists for.
 */
async function imageScope<T>(
	deps: FlockDeps,
	dirArg: string | undefined,
	opts: { host?: string },
	fn: (handle: string, slug: string) => Promise<T>
): Promise<T> {
	const dir = resolve(dirArg ?? ".");
	const host = flockTarget(opts.host);
	const link = readLink(dir);
	const manifest = readManifest(dir);
	const handle =
		(link.host && link.host !== host ? undefined : link.handle) ?? (await callerHandle(deps));
	return fn(handle, manifest.slug);
}

/** One image as a row: the address, what it serves, and who can get at it. */
function printImage(image: AppImage | AppImageSummary): void {
	console.log(
		[
			`${image.owner.handle}/${image.slug}`,
			image.current_release === null ? "not deployed" : `v${image.current_release}`,
			image.visibility === "public" ? "public" : "private",
			`${image.install_count} install(s)`,
			image.archived_at ? "archived" : ""
		]
			.filter(Boolean)
			.join("\t")
	);
}

async function setVisibility(
	deps: FlockDeps,
	dirArg: string | undefined,
	opts: { host?: string },
	visibility: "public" | "private"
): Promise<void> {
	await imageScope(deps, dirArg, opts, async (handle, slug) => {
		const image = unwrap(
			await updateAppImage({
				client: await appClient(deps),
				path: { handle, slug },
				body: { visibility }
			}),
			`updating ${handle}/${slug}`
		);
		// "Public" and "in the catalogue" are two different things, and only one of them is this
		// call's to grant: the catalogue lists approved owners, so for everyone else public means
		// anyone with the address may install it, which is worth stating rather than implying a
		// listing that will not appear.
		console.error(
			visibility === "public"
				? `${handle}/${slug} is public — anyone signed in may install it from ` +
						`its page. Listing it in the catalogue is Reduck's to grant, separately.`
				: `${handle}/${slug} is private again; the ${image.install_count} existing install(s) keep running`
		);
	});
}

function parsePairs(tokens: string[], what: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq <= 0) throw new Error(`${what} takes KEY=VALUE, got: ${token}`);
		out[token.slice(0, eq)] = token.slice(eq + 1);
	}
	return out;
}

/** "brand.domain=reduck.ai" → {brand: {domain: "reduck.ai"}}, values parsed as JSON when they can be. */
function nestPairs(pairs: Record<string, string>): Record<string, unknown> {
	const doc: Record<string, unknown> = {};
	for (const [path, raw] of Object.entries(pairs)) {
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			value = raw;
		}
		const segments = path.split(".");
		let node = doc;
		for (const segment of segments.slice(0, -1)) {
			if (typeof node[segment] !== "object" || node[segment] === null) node[segment] = {};
			node = node[segment] as Record<string, unknown>;
		}
		node[segments[segments.length - 1]] = value;
	}
	return doc;
}

/** "brand.domain" → {brand: {domain: null}} — a merge patch's `null` deletes. */
function nullPath(path: string): Record<string, unknown> {
	const segments = path.split(".");
	let leaf: unknown = null;
	for (let i = segments.length - 1; i > 0; i--) leaf = { [segments[i]]: leaf };
	return { [segments[0]]: leaf } as Record<string, unknown>;
}

/** One prompt row as `/decide/<uuid>/prompts` answers it. `live` is the pointer's word. */
interface PromptRow {
	id: number;
	name: string;
	version: number;
	template: string;
	body: string;
	draft: boolean;
	live?: boolean;
	note?: string | null;
	parent_id?: number | null;
	promoted_at?: string | null;
}

/** One line of `GET /prompts` with no name: the live version, the draft numbers, the live sweep. */
interface PromptSummary {
	name: string;
	live: number | null;
	drafts: number[];
	sweep: Sweep | null;
}

/** One judge's verdict on one document, as the door stores it. */
interface Ruling {
	output?: { valid?: boolean };
	reasoning?: { claim?: string; supporting?: boolean }[];
}

interface Sweep {
	cases: number;
	passed: number;
	/** The ruled cases this version has never been scored on — what a night of ruling left behind,
	 *  plus any draft scored under a judge that has since been replaced. `cases` counts what was
	 *  scored under the ruler that STANDS, so without this a scorecard cannot say it is stale. */
	unscored: number[];
	/** Whose judge ruled the drafts: the live version. Null for a wording graded by comparison,
	 *  which has no judge and therefore nothing that can go stale. */
	judge: number | null;
	/** How many cases carry a calibration at all — the denominator of `calibrated`, and a
	 *  different corpus from `cases`: the two halves are swept separately. */
	cal_cases: number;
	/** How many cases the wording's own judge agreed with the HUMAN on — the reply a person sent
	 *  ruled valid, the draft they overturned ruled invalid. `null` when the wording has a right
	 *  answer and was graded by comparison instead, which is a different question rather than a
	 *  score of zero. */
	calibrated: number | null;
	/** Where this version's judge disagreed with the human — the RULES' problem, kept apart from
	 *  `failed` (the guidance's) because the two send a fixer to different loops. */
	miscalibrated: {
		decision: number;
		ref: string | null;
		note: string | null;
		grader?: { draft?: Ruling; final?: Ruling; proposed?: Ruling; calibrated?: boolean };
	}[];
	failed: {
		decision: number;
		ref: string | null;
		expected: unknown;
		got: unknown;
		note: string | null;
		/** Present on a judge-graded case: what the judge said about each document it was shown. */
		grader?: { draft?: Ruling; final?: Ruling; proposed?: Ruling; calibrated?: boolean };
	}[];
}

interface DecisionSummary {
	id: number;
	prompt: string;
	version: number;
	ref: string | null;
	verdict: string | null;
	opening?: string;
	/** A RULED ROW'S PAYLOAD IS ITS DIFF, and all three fields are already on the wire:
	 *  what the wording proposed, what the human ruled, and why. The
	 *  opening answers what an UNRULED row is about; for a ruled one the question is what changed. */
	ruledAt?: string | null;
	output?: unknown;
	proposed?: unknown;
	feedback?: string | null;
}

interface DecisionRow extends DecisionSummary {
	evidence: string;
	output: unknown;
	proposed: unknown;
	feedback: string | null;
	reasoning: { claim: string; supporting: boolean }[];
}

// ── registration ────────────────────────────────────────────────────────────

export function registerFlockCommands(program: Command, deps: FlockDeps): void {
	const flock = program
		.command("flock", experimental())
		.description(
			"Build a folder into an installable app, and operate the installs. Served at flock.reduck.ai/app/<uuid>."
		)
		.addHelpText(
			"after",
			`
ONE FOLDER IS AN IMAGE; EVERY INSTALL OF IT IS AN APP. The folder is built once into an
artefact anybody may install, and each install is a running copy with its own database,
its own blobs and its own secret values. Deploying reaches every install at once.

An image is a folder of authored files, plus three optional folders:

  manifest.json    the whole install contract: its slug and name, the \`config\` schema the
                   app is interpreted under (its \`default\` values are what an install
                   starts from), the \`secrets\` an install is asked for, the \`hosts\` the
                   page may reach, the \`tools\` (task NAMES an agent may call — the
                   description and schemas are the task file's own exports, read from the
                   build), the \`hooks\`: the tasks flock runs by itself, by moment —
                   {"init": <task>} once per app at its first open, {"newUser": <task>}
                   once per person at theirs — and the \`scripts\`: every Reduck script
                   the app may run, as
                   [owner/]host/slug addresses. A run naming any other is refused
  front.jsx        the whole page — one React file, bundled here at deploy time
  migrations/      the tables: ordered SQL every install climbs from empty, so a fresh
                   database and a year-old one ran the same files
  tasks/*.ts       server-side work, run off the tab — see \`flock task\`, and \`flock cron\`
                   to put one on a clock. No name is special: a task flock should run by
                   itself is named in the manifest's \`hooks\`
  lib/*.js         shared by the page and its tasks; \`import … from "flock"\` resolves to
                   whichever half is building, so the same file works in both
  SKILL.md         optional: how to combine the \`tools\` for a purpose. An agent reads it after
                   the tool declarations, which the build injects — so it names tools and
                   never restates a schema
  tests/           optional: the offline suite that \`flock test\` runs. Its files import
                   the doors from "flock/testing", in memory, and nothing ships them

A deploy checks that every \${VAR} the manifest's hosts spend is declared in its secrets,
so an install is actually asked for it, that every task the manifest's \`tools\` and
\`hooks\` name was built, and that every entry of \`scripts\` is an address.

npm dependencies work in all of them. They are bundled here, from the node_modules of the
checkout the app lives in — nothing is installed server-side, and a task's sandbox has no
DOM, no filesystem and no network, so a package that reaches for one will not work there.

Reduck's own API is not a host: script runs and model calls go through the \`reduck\`
door, which carries the token of whoever is looking at the page and runs only the
scripts the manifest lists — so signing in to Reduck is what pays for both. A provider
you want to call directly is an ordinary third-party host — declare it and set its key
with secrets:set, like any other. So is the Reduck MCP itself, reached through \`fetch\`
with an API key of the app's own, for anything the \`reduck\` door does not open.

Examples:
  $ npx @reduck-ai/cli@latest flock init ./my-app
  $ npx @reduck-ai/cli@latest flock test ./my-app
  $ npx @reduck-ai/cli@latest flock deploy ./my-app
  $ npx @reduck-ai/cli@latest flock install @you/my-app --name "Mine"
  $ npx @reduck-ai/cli@latest flock prompt edit qualify
  $ npx @reduck-ai/cli@latest flock task enrich '{"domain":"stripe.com"}'
  $ npx @reduck-ai/cli@latest flock cron:add digest "0 9 * * *"
  $ npx @reduck-ai/cli@latest flock secrets:set NOTION_TOKEN=secret_…
  $ REDUCK_FLOCK_URL=https://flock.example.com npx @reduck-ai/cli@latest flock deploy ./my-app`
		);

	const target = (cmd: Command): Command =>
		cmd
			.option(
				"--app <uuid>",
				"The app to act on (default: the one in the folder's flock.json)."
			)
			.option(
				"--host <url>",
				"The flock host (default: $REDUCK_FLOCK_URL, else flock.reduck.ai)."
			);

	// No `target()`: there is no app to act on, and no credential to hold. A reader has to be
	// able to learn what a flock app is before they have an account, which is also why the door
	// this reads is public.
	flock
		.command("docs")
		.option(
			"--host <url>",
			"The flock host to read it from (default: $REDUCK_FLOCK_URL, else flock.reduck.ai)."
		)
		.description("Print the guide: how to build a flock app, and every interface it may use.")
		.addHelpText(
			"after",
			`
FETCHED FROM THE HOST, never bundled here — the same rule the client runtime follows: the half
that ANSWERS a door hands out its own description, so this cannot describe doors older or newer
than the ones you are about to call.

It is the whole of what an app may use, and it deliberately does not repeat this CLI: every verb
documents itself with --help.

Examples:
  $ npx @reduck-ai/cli@latest flock docs
  $ npx @reduck-ai/cli@latest flock docs > flock.md
  $ REDUCK_FLOCK_URL=https://flock.example.com npx @reduck-ai/cli@latest flock docs`
		)
		.action(async (opts: { host?: string }) => {
			const host = flockTarget(opts.host);
			let res: Response;
			try {
				res = await fetch(`${host}/docs`, { headers: extraHeaders() });
			} catch (e) {
				throw new Error(
					`could not reach ${host}: ${e instanceof Error ? e.message : String(e)}`
				);
			}
			const text = await res.text();
			if (!res.ok)
				throw new Error(
					`GET ${host}/docs → ${res.status} (is this a flock host, and is it deployed?)`
				);
			console.log(text);
		});

	// No `target()`: init writes files and talks to nothing, so neither --app nor --host means
	// anything to it.
	flock
		.command("init")
		.argument("[dir]", "Where to write it (default: the current directory).")
		.option("--slug <slug>", "The address, chosen once (default: the folder's name).")
		.option("--name <name>", "The display name (default: the folder's name).")
		.description("Write the folder a deploy expects: a page, its tables, and a manifest.")
		.action((dir: string | undefined, opts: { slug?: string; name?: string }) =>
			initCmd(dir, opts)
		);

	target(
		flock
			.command("deploy")
			.argument("[dir]", "The image folder (default: the current directory).")
			.option(
				"--project <handle>",
				"Create the image in a project rather than your own account. " +
					"Only read on the first deploy, when the image is created."
			)
			.option(
				"--esbuild <path>",
				"Path to esbuild (default: the app folder's, then the PATH)."
			)
			.option(
				"--minify",
				"Minify the bundle. Off by default, so a stack trace in the tab stays readable."
			)
			.description(
				"Build the folder and ship it as a release. Every install picks it up on its next load."
			)
	).action((dir, opts) => deployCmd(deps, dir, opts));

	// The first third of a deploy, kept on disk: what would ship, before anything is created or
	// uploaded. Needs no account — the host is asked only for its client runtime — so it is what
	// a test of the bundle drives, and what an author reads before shipping a page that misbehaves.
	target(
		flock
			.command("build")
			.argument("[dir]", "The image folder (default: the current directory).")
			.requiredOption("--out <dir>", "Where to write the files deploy would ship.")
			.option(
				"--esbuild <path>",
				"Path to esbuild (default: the app folder's, then the PATH)."
			)
			.option("--minify", "Minify the bundle, as deploy --minify would.")
			.description(
				"Build the folder as deploy would and keep the files. Nothing is uploaded."
			)
	).action(
		async (dir, opts: { out: string; host?: string; esbuild?: string; minify?: boolean }) => {
			const built = await build(resolve(dir ?? "."), flockTarget(opts.host), opts);
			for (const [name, code] of Object.entries(built.files)) {
				const at = join(opts.out, name);
				mkdirSync(dirname(at), { recursive: true });
				writeFileSync(at, code);
			}
			console.error(
				`Built ${Object.keys(built.files).join(", ")} in ${built.ms}ms into ${opts.out}`
			);
		}
	);

	// No `target()`: the suite acts on no app and needs no account. The host is asked only for its
	// client runtime and its test kit, as `build` asks it for the runtime.
	flock
		.command("test")
		.argument("[dir]", "The folder that holds the tests (default: the current directory).")
		.option(
			"--host <url>",
			"The flock host to get the runtime and the test kit from (default: $REDUCK_FLOCK_URL, else flock.reduck.ai)."
		)
		.description(
			"Run the folder's offline tests against the host's runtime and test kit. Nothing is uploaded."
		)
		.addHelpText(
			"after",
			`
The tests are the files that node --test finds in the folder, for example tests/*.test.mjs.
In them, "flock" and "flock/router" resolve to the runtime that the host serves, as in a
deploy. "flock/testing" resolves to the host's test kit: makeDoors({ appDir }) gives the
doors of an app in memory, with a database made from the folder's own migrations/. The
Reduck runs, the model calls and the requests to other hosts get their answers from the
test (makeDoors' scripts, verdicts and served). Read the kit:

  curl -s "$REDUCK_FLOCK_URL/client/harness.mjs"

The kit needs Node 24.15 or later. The exit status is the status of node --test.

Examples:
  $ npx @reduck-ai/cli@latest flock test ./my-app
  $ REDUCK_FLOCK_URL=https://flock.example.com npx @reduck-ai/cli@latest flock test ./my-app`
		)
		.action((dir: string | undefined, opts: { host?: string }) => testCmd(dir, opts));

	target(
		flock
			.command("install")
			.argument("<image>", 'The image to install — "@username/slug" or "project-slug/slug".')
			.option("--project <handle>", "Install into a project rather than your own account.")
			.option("--name <name>", "What to call this install (default: the image's name).")
			.option("--dir <dir>", "The folder to link it into (default: the current directory).")
			.option(
				"--set <key=value...>",
				"A setting to start from, dotted (brand.domain=reduck.ai). Repeatable."
			)
			.option(
				"--secret <NAME=value...>",
				"A value for one of the secrets the image needs. Repeatable."
			)
			.description(
				"Mint an app from an image: its own database, its own blobs, its own secret values."
			)
	).action((image: string, opts) => installCmd(deps, image, opts));

	target(
		flock
			.command("images")
			.option("--project <handle>", 'Only this owner\'s images (a project slug, or "@user").')
			.option("--catalogue", "The public catalogue instead — what anyone may install.")
			.description("The images you can reach: your own, your projects', and the catalogue.")
	).action(async (opts: { project?: string; catalogue?: boolean }) => {
		const client = await appClient(deps);
		const page = opts.project
			? unwrap(
					await listAppImages({
						client,
						path: { handle: opts.project },
						query: { page_size: 100 }
					}),
					`listing ${opts.project}'s images`
				)
			: unwrap(
					await listAllAppImages({
						client,
						query: {
							page_size: 100,
							...(opts.catalogue ? { catalogue_only: "true" } : {})
						}
					}),
					"listing images"
				);
		if (!page.data.length) {
			console.error("No images yet — `reduck flock deploy`.");
			return;
		}
		for (const image of page.data) printImage(image);
		if (page.has_next_page)
			console.error(`\n… and more (showing ${page.data.length} of ${page.total_count}).`);
	});

	target(
		flock
			.command("image")
			.argument("[dir]", "The image folder (default: the current directory).")
			.description("One image: what it is, what it serves, and how many apps run it.")
	).action((dir, opts) =>
		imageScope(deps, dir, opts, async (handle, slug) => {
			const client = await appClient(deps);
			const image = unwrap(
				await getAppImage({ client, path: { handle, slug } }),
				`reading ${handle}/${slug}`
			);
			printImage(image);
			console.log(`\nabout:    ${image.about || "—"}`);
			console.log(`installs: ${image.install_count}`);
			console.log(`releases: ${image.release_count}`);
			const needs = image.manifest?.secrets ?? [];
			console.log(
				`needs:    ${
					needs
						.map(
							(s) =>
								`${s.name}${s.required ? "" : " (optional)"}${s.page ? " [page]" : ""}`
						)
						.join(", ") || "nothing"
				}`
			);
		})
	);

	target(
		flock
			.command("publish")
			.argument("[dir]", "The image folder (default: the current directory).")
			.description("Make it public: anyone signed in may install it.")
	).action((dir, opts) => setVisibility(deps, dir, opts, "public"));

	target(
		flock
			.command("unpublish")
			.argument("[dir]", "The image folder (default: the current directory).")
			.description("Take it out of the catalogue. Apps already installed keep running.")
	).action((dir, opts) => setVisibility(deps, dir, opts, "private"));

	target(
		flock
			.command("archive")
			.argument("[dir]", "The image folder (default: the current directory).")
			.description(
				"Withdraw the image: no new installs, no new releases. Existing apps keep running."
			)
	).action((dir, opts) =>
		imageScope(deps, dir, opts, async (handle, slug) => {
			const image = unwrap(
				await archiveAppImage({ client: await appClient(deps), path: { handle, slug } }),
				`archiving ${handle}/${slug}`
			);
			console.error(
				`Archived ${handle}/${slug}${
					image.install_count ? ` — ${image.install_count} install(s) keep running` : ""
				}`
			);
		})
	);

	target(
		flock
			.command("unarchive")
			.argument("[dir]", "The image folder (default: the current directory).")
			.description("Put a withdrawn image back. Nothing was destroyed.")
	).action((dir, opts) =>
		imageScope(deps, dir, opts, async (handle, slug) => {
			unwrap(
				await restoreAppImage({ client: await appClient(deps), path: { handle, slug } }),
				`restoring ${handle}/${slug}`
			);
			console.error(`Restored ${handle}/${slug}`);
		})
	);

	target(
		flock
			.command("apps")
			.option("--project <handle>", 'Only this owner\'s apps (a project slug, or "@user").')
			.description("List the apps you can reach on this flock: your own, and your projects'.")
	).action(async (opts: { host?: string; project?: string }) => {
		const client = await appClient(deps);
		const page = opts.project
			? unwrap(
					await listApps({
						client,
						path: { handle: opts.project },
						query: { page_size: 100 }
					}),
					`listing ${opts.project}'s apps`
				)
			: unwrap(await listAllApps({ client, query: { page_size: 100 } }), "listing your apps");

		if (!page.data.length) {
			console.error("No apps yet — `reduck flock deploy`.");
			return;
		}
		const host = flockTarget(opts.host);
		for (const app of page.data) printApp(app, host);
		if (page.has_next_page)
			console.error(`\n… and more (showing ${page.data.length} of ${page.total_count}).`);
	});

	target(
		flock
			.command("info")
			.argument("[dir]", "The app folder (default: the current directory).")
			.description(
				"Everything about one install: what it runs, its config, its secret names."
			)
	).action((dir, opts) =>
		appScope(deps, dir, opts, async (handle, appId) => {
			const client = await appClient(deps);
			const app: App = unwrap(
				await getApp({ client, path: { handle, app_id: appId } }),
				`reading app ${appId}`
			);
			printApp(app, flockTarget(opts.host));
			console.log(
				`\nruns:    ${
					app.image
						? `${app.image.handle}/${app.image.slug}`
						: "nothing — its image is gone"
				}`
			);
			// Behind its image means an update has not landed here: a migration that would not
			// apply leaves an app on the code that matches the schema it actually has.
			if (app.image && app.image.current_release !== app.current_release) {
				console.log(
					`         behind — the image is on v${app.image.current_release}, this is on ` +
						`${app.current_release === null ? "nothing" : `v${app.current_release}`}`
				);
			}
			console.log(
				`secrets: ${
					app.secrets
						.map((s) => `${s.name}${s.page_usable ? " (page)" : ""}`)
						.join(", ") || "none"
				}`
			);
			console.log(
				`grant:   ${Object.keys(app.api_grant as Record<string, unknown>).join(", ") || "none"}`
			);
			console.log(`config:  ${JSON.stringify(app.config, null, 2)}`);
		})
	);

	target(
		flock
			.command("open")
			.argument("[dir]", "The app folder (default: the current directory).")
			.description("Open the app in a browser.")
	).action((dir, opts) =>
		withApp(dir, opts, async (host, appId) => {
			const url = `${host}/app/${appId}`;
			console.log(url);
			openBrowser(url);
		})
	);

	target(
		flock
			.command("config")
			.argument("[dir]", "The app folder (default: the current directory).")
			.description("Print the app's config document.")
	).action((dir, opts) =>
		withApp(dir, opts, async (host, appId) =>
			console.log(
				JSON.stringify(await call(deps, host, "GET", `/api/apps/${appId}/config`), null, 2)
			)
		)
	);

	target(
		flock
			.command("config:set")
			.argument(
				"<pairs...>",
				"PATH=VALUE, dotted (brand.domain=reduck.ai). Values parse as JSON when they can."
			)
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("Merge values into the app's config document.")
	).action((pairs: string[], opts: { dir?: string; app?: string; host?: string }) =>
		withApp(opts.dir, opts, async (host, appId) =>
			console.log(
				JSON.stringify(
					await call(
						deps,
						host,
						"PATCH",
						`/api/apps/${appId}/config`,
						nestPairs(parsePairs(pairs, "config:set"))
					),
					null,
					2
				)
			)
		)
	);

	target(
		flock
			.command("config:unset")
			.argument("<paths...>", "Dotted paths to remove (brand.domain).")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("Remove values from the app's config document.")
	).action((paths: string[], opts: { dir?: string; app?: string; host?: string }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			let doc: unknown;
			for (const path of paths)
				doc = await call(deps, host, "PATCH", `/api/apps/${appId}/config`, nullPath(path));
			console.log(JSON.stringify(doc, null, 2));
		})
	);

	target(
		flock
			.command("task")
			.argument("<name>", "Which task to run — `tasks/<name>.ts` in the app folder.")
			.argument("[args]", "Its arguments, as JSON. Default: {}")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option("--file <path>", "Read the arguments from a JSON file instead.")
			.option(
				"--wait",
				"Poll until it ends, print its result and logs, and exit 0 or 1 on the outcome."
			)
			.option("--json", "With --wait: print the whole terminal record as JSON on stdout.")
			.description("Run one of the app's tasks server-side. Returns as soon as it starts.")
			.addHelpText(
				"after",
				`
The same door the app's page uses, so a task behaves identically either way — what
differs is only whose Reduck account its nested script runs spend: the viewer's from
the page, yours from here.

By default it does NOT wait: a task outliving your shell is the point, and its effects
are the rows it wrote, which you can read back with \`flock sql\`.

--wait polls on the pacing the host itself advertises and EXITS 0 OR 1 on the outcome,
which is what makes a task composable — \`flock task nightly --wait || alert\`, or a
crontab line that can fail. It also prints the task's own console output, which
\`flock task:logs <id>\` reads back afterwards. Waiting costs nothing to give up: the
task is the host's, so a ^C here leaves it running and its record still lands.

Fan-out is your shell's, because a task is one unit of work:

  $ printf '%s\\n' a.com b.com | xargs -P 4 -I{} \\
      npx @reduck-ai/cli@latest flock task enrich '{"domain":"{}"}' --wait --json

Examples:
  $ npx @reduck-ai/cli@latest flock task enrich '{"domain":"stripe.com"}'
  $ npx @reduck-ai/cli@latest flock task nightly --wait
  $ npx @reduck-ai/cli@latest flock task enrich --file args.json`
			)
	).action(
		(
			name: string,
			args: string | undefined,
			opts: {
				dir?: string;
				app?: string;
				host?: string;
				file?: string;
				wait?: boolean;
				json?: boolean;
			}
		) =>
			withApp(opts.dir, opts, async (host, appId) => {
				const raw = opts.file ? readFileSync(opts.file, "utf8") : args;
				let payload: unknown = {};
				if (raw?.trim()) {
					try {
						payload = JSON.parse(raw);
					} catch (e) {
						throw new Error(`arguments are not JSON: ${(e as Error).message}`);
					}
				}
				const started = await call<{ taskId: string; task: string }>(
					deps,
					host,
					"POST",
					`/api/apps/${appId}/task/${encodeURIComponent(name)}`,
					payload
				);
				if (!opts.wait) {
					// stderr for the prose, stdout for the id — so a script can capture the one
					// thing it might want to correlate a log line against.
					console.error(
						`Started ${started.task} — it runs on its own from here. ` +
							`Read it back with \`flock task:logs ${started.taskId}\`.`
					);
					console.log(started.taskId);
					return;
				}

				console.error(`Started ${started.task} ${started.taskId.slice(0, 8)} — waiting…`);
				// PACED BY THE HOST, never by a number invented here: every 202 carries
				// `retryAfterMs`, so a change there needs nothing from this file.
				let state: TaskRecord;
				for (;;) {
					state = await call<TaskRecord>(
						deps,
						host,
						"GET",
						`/api/apps/${appId}/task/${encodeURIComponent(started.taskId)}`,
						undefined,
						202
					);
					if (state.status !== "running") break;
					await new Promise((r) => setTimeout(r, state.retryAfterMs ?? 2000));
				}

				// stdout is the ANSWER, stderr the prose — so `| jq` gets only the result and a
				// parallel fan-out stays readable.
				if (opts.json) console.log(JSON.stringify(state, null, 2));
				else if (state.result !== undefined && state.result !== null)
					console.log(JSON.stringify(state.result, null, 2));

				for (const line of state.logs ?? []) console.error(`  ${line}`);
				if (state.error) console.error(state.error);
				// Flushed before the verdict, or the two streams land out of order in a terminal:
				// stderr is unbuffered and stdout is not, so the outcome would print above the
				// answer it is about.
				await new Promise((r) => process.stdout.write("", () => r(undefined)));
				const took =
					state.startedAt && state.finishedAt
						? ` in ${((Date.parse(state.finishedAt) - Date.parse(state.startedAt)) / 1000).toFixed(1)}s`
						: "";
				console.error(`${started.task} ${state.status}${took}`);
				if (state.status !== "ok") process.exitCode = 1;
			})
	);

	// ── the record a run leaves ─────────────────────────────────────────────
	//
	// The same handlers the page's `/task` door serves, behind the operator's credential —
	// so a run started from a page and one started from here are read the same way. What
	// differs is only that an operator sees everyone's, while a viewer sees their own.

	const printTask = (t: TaskSummary): void => {
		const mark = { ok: "✓", error: "✗", lost: "?", running: "⋯" }[t.status] ?? " ";
		const took =
			t.finishedAt && t.startedAt
				? `${((Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 1000).toFixed(1)}s`
				: "—";
		const lines = t.logLines ? `  ${t.logLines} line(s)` : "";
		// The whole id, not a prefix of it: `task:logs` looks one up by exact id, so a
		// listing that abbreviated would print something nobody can paste anywhere.
		console.log(
			`${mark} ${t.taskId}  ${t.task}  ${t.trigger}  ${t.startedAt}  ${took}${lines}`
		);
		if (t.error) console.log(`    ${t.error.split("\n")[0]}`);
	};

	target(
		flock
			.command("tasks")
			.argument("[dir]", "The app folder (default: the current directory).")
			.option("--task <name>", "Only runs of this task.")
			.option("--status <status>", "One of running, ok, error, lost.")
			.option("--limit <n>", "How many to show. Default: 50.")
			.option("--json", "Print the whole page as JSON on stdout.")
			.description("List the app's task runs — everyone's, since this is the owner's door.")
			.addHelpText(
				"after",
				`
Newest first, and it carries no output: a run's logs are fetched one at a time with
\`flock task:logs\`, because fifty of them is megabytes nobody asked for. What a row
does say is how much there is to fetch — \`logLines\`, and \`hasResult\` for the half that
is not lines, which \`flock task:logs <id> --json\` answers.

A refused launch is a row too — "no such task in this release", "the pool was full" —
which is why a stopped schedule can say why without a column for it.

Examples:
  $ npx @reduck-ai/cli@latest flock tasks
  $ npx @reduck-ai/cli@latest flock tasks --status error --task nightly`
			)
	).action(
		(
			dir: string | undefined,
			opts: {
				app?: string;
				host?: string;
				task?: string;
				status?: string;
				limit?: string;
				json?: boolean;
			}
		) =>
			withApp(dir, opts, async (host, appId) => {
				const q = new URLSearchParams();
				for (const [k, v] of Object.entries({
					task: opts.task,
					status: opts.status,
					limit: opts.limit
				}))
					if (v !== undefined) q.set(k, v);
				const page = await call<{ tasks: TaskSummary[]; next: string | null }>(
					deps,
					host,
					"GET",
					`/api/apps/${appId}/task${q.size ? `?${q}` : ""}`
				);
				if (opts.json) {
					console.log(JSON.stringify(page, null, 2));
					return;
				}
				if (!page.tasks.length) {
					console.error("No runs yet — `flock task <name>`.");
					return;
				}
				for (const t of page.tasks) printTask(t);
				// The cursor is opaque and the flag is not built yet, so say what is there
				// rather than offering a way to reach it that does not exist.
				if (page.next) console.error(`… and more before ${page.tasks.at(-1)?.startedAt}`);
			})
	);

	target(
		flock
			.command("task:logs")
			.argument("<id>", "A task id, from `flock tasks` or from starting one.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option(
				"--json",
				"Print the whole record as JSON on stdout — the logs, and the result."
			)
			.description("Print what one run printed.")
			.addHelpText(
				"after",
				`
THE LINES GO TO STDOUT and the verdict to stderr, which is the opposite way round from
\`flock task --wait\` — there the result is the answer and the logs are prose, here the
logs ARE the answer. So \`| grep\` and \`> file\` work on the thing you asked for.

A task's console output is capped, and a record that was cut says so in a line of its
own rather than ending early. Keep what you need to keep through \`sql\`.

--json IS HOW A RESULT IS READ BACK. \`flock task --wait\` prints one at the moment a run
ends and there is no second chance at it — a run somebody else started, or one you
stopped waiting on, keeps its answer in the record and nothing else fetches it. This is
the same record, whole: the logs, the result, and how it ended. Then stdout is JSON and
only the verdict goes to stderr, so the log lines are not repeated outside the document
that already holds them.

Examples:
  $ npx @reduck-ai/cli@latest flock task:logs 8f21c0a4b3e14f5d9c2a7e6b1d4f8a03
  $ npx @reduck-ai/cli@latest flock task:logs 8f21c0a4b3e14f5d9c2a7e6b1d4f8a03 --json | jq .result
  $ npx @reduck-ai/cli@latest flock tasks --status error --json | jq -r '.tasks[0].taskId' \\
      | xargs npx @reduck-ai/cli@latest flock task:logs`
			)
	).action((id: string, opts: { dir?: string; app?: string; host?: string; json?: boolean }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			const state = await call<TaskRecord>(
				deps,
				host,
				"GET",
				`/api/apps/${appId}/task/${encodeURIComponent(id)}`,
				undefined,
				202
			);
			// THE SAME READ, TWO SHAPES — and only stdout differs, because the verdict and the exit
			// code below are what a caller composes on either way. `--json` answers the whole record
			// rather than a `result` key of its own: this call already holds it, `flock task --wait`
			// and `flock tasks` already spell "the whole thing, as JSON, on stdout" the same way, and
			// a second verb reading the same record through the same call would only be a second
			// place to look.
			if (opts.json) console.log(JSON.stringify(state, null, 2));
			else for (const line of state.logs ?? []) console.log(line);
			// The error after the lines rather than inside them: it is the ending, and a
			// record holding it twice would be a record that disagrees with itself.
			if (state.error) console.error(state.error);
			if (state.status === "running") console.error(`${state.task} is still running.`);
			else console.error(`${state.task} ${state.status}`);
			if (state.status === "error") process.exitCode = 1;
		})
	);

	// ── the wordings and the judgments ──────────────────────────────────────
	//
	// `flock prompt …` and `flock decision …` are the `/decide` door behind the operator's
	// credential — the page's own handler, so a shell and a page cannot disagree about a judgment
	// or a wording. Nothing here runs an app task: the host composes a template's `{{pointers}}`
	// from the config it already holds, judges an eval with the same code that makes a
	// production decision, and moves the pointer that says which version is live.
	//
	// A WORDING IS ADDRESSED `<name>[@<version>]`. Every save is a numbered version — a draft until
	// promoted — and a bare name is the LIVE one, so `get`, `edit` and `eval` read production by
	// default and a draft by number. `promote` names its version, because with several drafts on
	// the table there is no honest default.

	const decideCall = <T>(
		host: string,
		appId: string,
		method: string,
		tail: string,
		body?: unknown
	) => call<T>(deps, host, method, `/api/apps/${appId}/decide${tail}`, body);

	// `qualify` → the live row; `qualify@5` → that version. The lineage is one read either way.
	const resolvePrompt = async (
		host: string,
		appId: string,
		address: string
	): Promise<PromptRow> => {
		const [name, at] = address.split("@");
		const { prompts } = await decideCall<{ prompts: PromptRow[] }>(
			host,
			appId,
			"GET",
			`/prompts?name=${encodeURIComponent(name)}`
		);
		if (!prompts.length)
			throw new Error(`no wording "${name}" — \`flock prompt list\` names this app's`);
		if (at === undefined) {
			const live = prompts.find((p) => p.live);
			if (!live) throw new Error(`"${name}" has versions but none is live — promote one`);
			return live;
		}
		const row = prompts.find((p) => String(p.version) === at);
		if (!row)
			throw new Error(
				`no ${name}@${at} — it has ${prompts.map((p) => `@${p.version}`).join(", ")}`
			);
		return row;
	};

	const versionLabel = (p: PromptRow) =>
		`${p.name}@${p.version}`.padEnd(18) +
		(p.live ? "live   " : p.draft ? "draft  " : "frozen ") +
		(p.promoted_at ? String(p.promoted_at).slice(0, 10) : "          ") +
		(p.note ? `  ${p.note}` : "");

	// A SCORECARD THAT CAN SAY IT IS OUT OF DATE. `+N unscored` is rulings no sweep of this version
	// has met, so a version with nothing scored but a waiting board still prints — which is the one
	// case the old `!s.cases` bail got wrong, and the one worth seeing.
	// BOTH NUMBERS, because they are scored separately and read in order: the judge first (a bent
	// ruler makes the drafts meaningless), then the drafts under it. `+N unscored` last, since it
	// says the numbers before it are out of date rather than being a result of its own.
	const sweepLabel = (s: Sweep | null | undefined) => {
		if (!s) return "";
		const drafts = s.cases
			? `${s.passed}/${s.cases}${s.failed.length ? ` (${s.failed.length} red)` : ""}`
			: "";
		const judge = s.calibrated === null ? "" : `judge ${s.calibrated}/${s.cal_cases}`;
		const scored = [drafts, judge].filter(Boolean).join(" · ");
		// Joined with "+" so a version with nothing scored reads "2 unscored" rather than "+2".
		return [scored, s.unscored?.length ? `${s.unscored.length} unscored` : ""]
			.filter(Boolean)
			.join(" +");
	};

	const at = (ref: string | null) => (ref ? `\n        ${ref}` : "");
	const why = (r: Ruling | undefined) => r?.reasoning?.[0]?.claim ?? "no reason given";
	const clip = (value: unknown, n = 90) => {
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return (text ?? "").length > n ? `${text.slice(0, n)}…` : (text ?? "");
	};

	// THE SCORECARD SAYS WHAT IT MEASURED, in words. Two numbers for a wording whose answer is
	// prose, and they answer different questions — did the judge read the rules the way the human
	// does, and did the drafts pass it. The calibration block comes FIRST because a bent ruler
	// makes the second block meaningless, and the line between them says so.
	const printSweep = (s: Sweep) => {
		const off = s.miscalibrated ?? [];
		if (s.calibrated !== null) {
			console.error(
				`the judge derived from this wording agreed with the human on ${s.calibrated}/${s.cal_cases} rulings`
			);
			for (const f of off) {
				const said = f.grader ?? {};
				if (said.final?.output?.valid === false)
					console.error(
						`  #${f.decision}  called the human's own answer invalid — "${why(said.final)}"`
					);
				if (said.proposed?.output?.valid === true)
					console.error(
						`  #${f.decision}  called the answer they overturned valid${at(f.ref)}`
					);
				else if (said.final?.output?.valid === false)
					console.error(`${at(f.ref).slice(1)}`);
			}
			if (off.length)
				console.error(
					`  ${off.length} case(s), and one prints twice when its judge fails BOTH ` +
						`directions — fix the RULES and re-run with --judge before measuring drafts`
				);
		}
		// THE DRAFT HALF, and it is scored under the LIVE version's judge — which is why two
		// versions' numbers can be compared at all. `judge` names whose ruler they are under.
		if (s.cases || !s.unscored?.length) {
			console.error(
				s.judge
					? `${s.passed}/${s.cases} draft(s) passed judge@${s.judge}` +
							`${s.cases && s.passed === s.cases ? " — green" : ""}`
					: `${s.passed}/${s.cases} matched the human's ruling${s.failed.length ? "" : s.cases ? " — green" : " — no cases"}`
			);
		}
		for (const f of s.failed) {
			if (f.grader) {
				// A judge-graded miss: what it objected to, and the words it objected to them in.
				if (f.grader.draft?.output?.valid === false)
					console.error(
						`  #${f.decision}  invalid — "${why(f.grader.draft)}"\n` +
							`        draft: ${clip((f.got as { reply?: string })?.reply ?? f.got)}${at(f.ref)}`
					);
				continue;
			}
			console.error(
				`  #${f.decision}  expected ${JSON.stringify(f.expected)}  got ${JSON.stringify(f.got)}` +
					(f.note ? `  — ${f.note}` : "") +
					at(f.ref)
			);
		}
		// LAST, because it is not a result: it is what this scorecard has not measured. A red case
		// has been tested and is a known miss; one of these has never been put to the wording, so
		// it says the numbers above are out of date and names the command that fixes that.
		if (s.unscored?.length) {
			console.error(
				`${s.unscored.length} ruling(s) this version has not been scored on — ` +
					`\`flock decision list --prompt <name> --unscored\` reads them`
			);
		}
	};

	const prompt = flock
		.command("prompt")
		.description(
			"This install's wordings: list, read, edit into a draft, score it, promote it."
		)
		.addHelpText(
			"after",
			`
A wording is addressed <name>[@<version>]. Every save is a numbered version, a draft until it is
promoted, and a bare name means the LIVE one. So the loop after an idea, or after \`config:set\`:

  $ npx @reduck-ai/cli@latest flock prompt edit qualify --file q.md   the live template, reworked → a draft
  $ npx @reduck-ai/cli@latest flock prompt eval qualify@4       scored against every judgment a human ruled on
  $ npx @reduck-ai/cli@latest flock prompt promote qualify@4    live — the scorecard informs, the call is yours
  $ npx @reduck-ai/cli@latest flock prompt promote qualify@3    a rollback: the pointer moves, no row is written

THE SCORECARD beside a version reads \`passed/cases (N red) · judge A/B +N unscored\`, and the two
halves are SWEPT SEPARATELY (\`prompt eval\`, with and without \`--judge\`) because they answer
different questions:

  judge A/B  did the judge derived from THIS version read the human the way they read themselves —
             the reply they sent ruled valid, the draft they overturned ruled invalid. READ THIS
             FIRST: a draft score taken with a bent ruler says nothing. A red here is the RULES'
             problem
  passed     how many of this version's drafts passed — ruled by the LIVE version's judge, which
             is what makes two versions' numbers comparable at all. A red here is the drafting
             GUIDANCE's problem
  cases      how many drafts were scored under the ruler that stands
  red        drafts that failed. One calibration case can print twice, when its judge fails BOTH
             directions, so a printed line is not always a case
  unscored   rulings this version has never been scored on — a night of ruling, or a draft score
             taken under a judge since replaced (promoting a wording moves the ruler).
             \`flock decision list --prompt <name> --unscored\` deals them out`
		);

	target(
		prompt
			.command("list")
			.argument("[name]", "One wording: every version of it. Omit for one line per wording.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("What this install's wordings are, and which version of each is live.")
	).action((name: string | undefined, opts: { dir?: string; app?: string; host?: string }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			if (name) {
				const { prompts } = await decideCall<{ prompts: PromptRow[] }>(
					host,
					appId,
					"GET",
					`/prompts?name=${encodeURIComponent(name)}`
				);
				if (!prompts.length) throw new Error(`no wording "${name}"`);
				for (const p of prompts) console.log(versionLabel(p));
				return;
			}
			const { prompts } = await decideCall<{ prompts: PromptSummary[] }>(
				host,
				appId,
				"GET",
				"/prompts"
			);
			if (!prompts.length) {
				console.error(
					"No wordings yet."
				);
				return;
			}
			for (const p of prompts)
				console.log(
					`${p.name.padEnd(14)} ${p.live == null ? "(none live)" : `v${p.live}`.padEnd(6)}` +
						`${p.drafts.length ? `  drafts ${p.drafts.map((v) => `@${v}`).join(" ")}` : ""}` +
						`${sweepLabel(p.sweep) ? `  ${sweepLabel(p.sweep)}` : ""}`
				);
		})
	);

	target(
		prompt
			.command("get")
			.argument("<address>", "<name> for the live version, or <name>@<version>.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option(
				"--body",
				"Print the composed BODY — the bytes a model is sent — instead of the template."
			)
			.description("Read one version's template, or the bytes it composed to.")
			.addHelpText(
				"after",
				`
The TEMPLATE is what you edit; the BODY is that template with the config composed into its
{{pointers}}, frozen on the version. The heading goes to stderr, so \`> qualify.md\` is the text alone.`
			)
	).action(
		(address: string, opts: { dir?: string; app?: string; host?: string; body?: boolean }) =>
			withApp(opts.dir, opts, async (host, appId) => {
				const row = await resolvePrompt(host, appId, address);
				const full = await decideCall<PromptRow & { sweep: Sweep }>(
					host,
					appId,
					"GET",
					`/prompts/${row.id}`
				);
				console.error(
					`── ${versionLabel(full)}${sweepLabel(full.sweep) ? `  ${sweepLabel(full.sweep)}` : ""}`
				);
				console.log(opts.body ? full.body : full.template);
			})
	);

	target(
		prompt
			.command("edit")
			.argument(
				"<address>",
				"<name> to start from the live template; <name>@<version> from that one."
			)
			.argument("[template]", "The new template, inline. Omit and pass --file instead.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option("--file <path>", "Read the template from a file instead of the argument.")
			.option("--note <note>", "One line on what changed, kept on the version.")
			.description("Save a wording's template as a new draft.")
			.addHelpText(
				"after",
				`
The template arrives inline or from a file, the same two ways \`flock task\` takes its arguments.
Read the current one with \`flock prompt get\`, which prints it alone on stdout:

  $ npx @reduck-ai/cli@latest flock prompt get qualify > qualify.md
  $ npx @reduck-ai/cli@latest flock prompt edit qualify --file qualify.md
  $ npx @reduck-ai/cli@latest flock prompt edit qualify "$(cat qualify.md)"

NEVER MINTS. What you save is the next numbered version, a DRAFT: nobody judges under it until you
promote it, and it is scored first with \`flock prompt eval\`. Editing <name>@<version> where that
version is still a draft reshapes it in place (and clears its scorecard); a frozen version is the
starting point for a new draft. The host composes the body from today's config, and refuses by
name if a {{pointer}} is unanswered.`
			)
	).action(
		(
			address: string,
			template: string | undefined,
			opts: { dir?: string; app?: string; host?: string; file?: string; note?: string }
		) =>
			withApp(opts.dir, opts, async (host, appId) => {
				// One of the two, and saying so names both rather than only the one you skipped.
				const edited = opts.file ? readFileSync(opts.file, "utf8") : template;
				if (edited === undefined)
					throw new Error(
						"a template is required — pass it inline, or with --file. " +
							`\`flock prompt get ${address}\` prints the current one.`
					);
				const from = await resolvePrompt(host, appId, address);
				if (from.draft) {
					if (edited === from.template && !opts.note) {
						console.error("Unchanged.");
						return;
					}
					const row = await decideCall<PromptRow>(
						host,
						appId,
						"PATCH",
						`/prompts/${from.id}`,
						{
							template: edited,
							...(opts.note ? { note: opts.note } : {})
						}
					);
					console.error(
						`Reshaped ${row.name}@${row.version} (draft) — its scorecard is cleared.`
					);
					console.log(`${row.name}@${row.version}`);
					return;
				}
				const row = await decideCall<PromptRow>(host, appId, "POST", "/prompts", {
					name: from.name,
					template: edited,
					parent: from.id,
					...(opts.note ? { note: opts.note } : {})
				});
				console.error(
					`Draft ${row.name}@${row.version}, from @${from.version}` +
						(edited === from.template
							? " (same template, recomposed under today's config)"
							: "") +
						`. Score it: flock prompt eval ${row.name}@${row.version}`
				);
				console.log(`${row.name}@${row.version}`);
			})
	);

	target(
		prompt
			.command("eval")
			.argument(
				"<address>",
				"<name>@<version> to score a draft; <name> re-scores the live version."
			)
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option(
				"--judge",
				"Calibrate instead: hold this version's own judge to the human, and draft nothing."
			)
			.option(
				"--ref <ref>",
				"Only the cases about this ref — the same filter `decision list` takes."
			)
			.option("--limit <n>", "At most this many cases (default 200).")
			.description(
				"Score a version against the judgments a human ruled on, and keep the scorecard."
			)
			.addHelpText(
				"after",
				`
THE SAME JUDGING AS PRODUCTION: the host judges each case's frozen evidence with the code that
makes a decision — same envelope, same citation loop. A case is a judgment somebody edited,
rejected, or confirmed with a note.

HOW IT IS GRADED FOLLOWS FROM THE WORDING. One that answers with a right answer (a tier, a flag) is
compared to the human's ruling, and there is no judge to speak of. One that answers with PROSE
cannot be — two good replies are never the same string — so it is ruled on by a judge derived from
a wording's own body, read as "does this obey the instructions it was written under?". That gives
two questions, and they are SWEPT SEPARATELY:

  --judge     CALIBRATE this version's own judge against the human — the reply they sent must come
              back valid, the draft they overturned must not. Two calls per case and no drafting,
              so a rule fix is checked cheaply. A red here is the RULES' problem: fix them, re-run,
              and promote when the judge reads the human right.
  (no flag)   MEASURE this version's drafts, ruled by the LIVE version's judge. One ruler for every
              candidate is what makes two versions' numbers comparable — under its own judge a
              wording both sets the exam and sits it. A red here is the GUIDANCE's problem.

So the order is: calibrate, promote the better ruler, then measure candidates under it.

Resumable per half: a case already scored is skipped, so a run that dies picks up where it stopped.
Promoting a wording moves the ruler, which puts every other version's drafts back into \`unscored\` —
those scores are no longer comparable to anything. Each failure prints the decision id —
\`flock decision get <id>\` is the document it misread.`
			)
	).action(
		(
			address: string,
			opts: {
				dir?: string;
				app?: string;
				host?: string;
				judge?: boolean;
				ref?: string;
				limit?: string;
			}
		) =>
			withApp(opts.dir, opts, async (host, appId) => {
				const row = await resolvePrompt(host, appId, address);
				const filter = opts.ref ? { ref: opts.ref } : {};
				let sweep: Sweep = {
					cases: 0,
					passed: 0,
					unscored: [],
					judge: null,
					calibrated: null,
					cal_cases: 0,
					failed: [],
					miscalibrated: []
				};
				const started = Date.now();
				for (;;) {
					const step = await decideCall<{
						judged: number;
						pending: number;
						corpus: number;
						sweep: Sweep;
					}>(host, appId, "POST", `/prompts/${row.id}/eval`, {
						filter,
						...(opts.judge ? { judge: true } : {}),
						...(opts.limit ? { limit: Number(opts.limit) } : {})
					});
					sweep = step.sweep;
					if (!step.corpus) {
						console.error(
							"No cases: nothing a human has ruled on under this wording yet."
						);
						break;
					}
					console.error(`${step.sweep.cases}/${step.corpus} scored…`);
					if (!step.pending) break;
				}
				console.error(
					`── ${row.name}@${row.version}  ${sweep.cases} case(s) in ${Math.round((Date.now() - started) / 1000)}s`
				);
				printSweep(sweep);
				console.log(JSON.stringify({ prompt: `${row.name}@${row.version}`, ...sweep }));
				if (sweep.failed.length) process.exitCode = 1;
			})
	);

	target(
		prompt
			.command("promote")
			.argument("<address>", "<name>@<version> — the version to make live.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("Make a version the one production judges under.")
			.addHelpText(
				"after",
				`
Its scorecard prints first if it has one, and then it ships: a sweep measures, and whether that is
good enough to run is yours to decide. Promoting an older, frozen version is a ROLLBACK — the
pointer moves and no row is written, so history says what actually ruled each judgment.`
			)
	).action((address: string, opts: { dir?: string; app?: string; host?: string }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			if (!address.includes("@"))
				throw new Error(
					`promote names a version: ${address}@<version> — \`flock prompt list ${address}\``
				);
			const row = await resolvePrompt(host, appId, address);
			const full = await decideCall<PromptRow & { sweep: Sweep }>(
				host,
				appId,
				"GET",
				`/prompts/${row.id}`
			);
			if (full.sweep.cases) printSweep(full.sweep);
			const live = await decideCall<PromptRow & { already?: boolean }>(
				host,
				appId,
				"POST",
				`/prompts/${row.id}/promote`,
				{}
			);
			console.error(
				live.already
					? `${live.name}@${live.version} was already live.`
					: `${live.name}@${live.version} is live.`
			);
			console.log(`${live.name}@${live.version}`);
		})
	);

	const decision = flock
		.command("decision")
		.description("This install's judgments — the rows the `/decide` door holds.");

	// WHAT A ROW IS ABOUT depends on whether anybody has ruled it, so the payload does too. An
	// unruled row is a document nobody has read — its opening is the only thing that identifies
	// it. A ruled one is a lesson, and the lesson is the DIFF: what the wording proposed, and what
	// the human made of it. An edit shows both sides because the change IS the teaching; a refusal
	// shows only the draft, since a rejection carries no correct answer, only a wrong one.
	const payloadOf = (d: DecisionSummary): string => {
		if (!d.verdict)
			return String(d.opening ?? "")
				.replace(/\s+/g, " ")
				.slice(0, 70);
		if (d.verdict === "rejected") return clip(d.proposed, 70);
		if (d.verdict === "edited") return `${clip(d.proposed, 44)} → ${clip(d.output, 44)}`;
		return clip(d.output, 70);
	};

	target(
		decision
			.command("list")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option(
				"--prompt <address>",
				"Only judgments under this wording — <name>, or <name>@<version>."
			)
			.option(
				"--ref <ref>",
				"Only judgments carrying this ref (the app's own token, exactly)."
			)
			.option("--rulable", "Only what a human can act on now — the deck.")
			.option("--ruled", "Only what nobody can act on: ruled, or waiting on a gate.")
			.option(
				"--unscored",
				"Only the rulings this wording's sweep has never met. Needs --prompt."
			)
			.option("--limit <n>", "How many at most (default 50).")
			.option("--json", "The rows as JSON, exactly as the door answers.")
			.description("List judgments, newest first.")
			.addHelpText(
				"after",
				`
A RULED ROW PRINTS ITS DIFF — what the wording proposed, what you ruled, and your note — because
that is the lesson in it. An unruled one prints the document's opening, which is all there is to
say about a card nobody has read yet.

--unscored IS THE MORNING LIST: ground truth (edited, refused, or confirmed with a note) that no
sweep of this wording has been scored against. --ruled is history and includes every case an eval
already covers; these are the ones nothing has been done about.

Under --unscored the @version names the YARDSTICK rather than what judged the row: bare is the live
version ("what does production not know about"), @N a draft ("what has this not met"). Each row
still prints the version that actually judged it.

Examples:
  $ npx @reduck-ai/cli@latest flock decision list --prompt reply --unscored
  $ npx @reduck-ai/cli@latest flock decision list --prompt qualify@1 --ruled
  $ npx @reduck-ai/cli@latest flock decision list --prompt reply@5 --unscored   # before promoting @5`
			)
	).action(
		(opts: {
			dir?: string;
			app?: string;
			host?: string;
			prompt?: string;
			ref?: string;
			rulable?: boolean;
			ruled?: boolean;
			unscored?: boolean;
			limit?: string;
			json?: boolean;
		}) =>
			withApp(opts.dir, opts, async (host, appId) => {
				if (opts.unscored && !opts.prompt)
					throw new Error(
						"--unscored is measured against one wording's sweep — name it with " +
							"--prompt <name>[@<version>]"
					);
				const q = new URLSearchParams();
				// The same address grammar every `prompt` command takes, so one thing is spelled
				// one way: `qualify` is the live version, `qualify@1` that one.
				if (opts.prompt) {
					const [name, at] = opts.prompt.split("@");
					q.set("prompt", name);
					if (at !== undefined) q.set("version", at);
				}
				if (opts.ref) q.set("ref", opts.ref);
				if (opts.rulable) q.set("rulable", "true");
				if (opts.ruled) q.set("rulable", "false");
				if (opts.unscored) q.set("unscored", "true");
				if (opts.limit) q.set("limit", opts.limit);
				const body = await decideCall<{
					decisions: DecisionSummary[];
					next: number | null;
				}>(host, appId, "GET", q.size ? `?${q}` : "");
				if (opts.json) {
					console.log(JSON.stringify(body, null, 2));
					return;
				}
				for (const d of body.decisions) {
					console.log(
						`#${String(d.id).padEnd(6)} ${`${d.prompt} v${d.version}`.padEnd(14)} ` +
							`${(d.verdict ?? "pending").padEnd(9)} ` +
							`${String(d.ruledAt ?? "")
								.slice(0, 16)
								.replace("T", " ")
								.padEnd(16)}  ` +
							`${payloadOf(d)}${d.feedback ? `  — ${d.feedback}` : ""}`
					);
					// The ref on its own line: it is how you open the thing, and inline it would
					// either be truncated to uselessness or push the diff off the screen.
					if (d.ref) console.log(`${" ".repeat(8)}${d.ref}`);
				}
				console.error(
					`${body.decisions.length} judgment(s)${body.next ? ` — more after #${body.next}` : ""}` +
						(opts.unscored
							? ` this wording has not been scored on — \`flock prompt eval ${opts.prompt}\``
							: "")
				);
			})
	);

	target(
		decision
			.command("get")
			.argument("<id>", "The decision, as `decision list` prints it.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option("--json", "The whole hydrated row as JSON.")
			.description(
				"Read one judgment: the frozen evidence on stdout, the verdict and claims on stderr."
			)
	).action((id: string, opts: { dir?: string; app?: string; host?: string; json?: boolean }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			const d = await decideCall<DecisionRow>(
				host,
				appId,
				"GET",
				`/${encodeURIComponent(id)}`
			);
			if (opts.json) {
				console.log(JSON.stringify(d, null, 2));
				return;
			}
			console.error(
				`── #${d.id}  ${d.prompt} v${d.version}  ${d.verdict ?? "pending"}${d.ref ? `  ${d.ref}` : ""}`
			);
			console.error(`proposed ${JSON.stringify(d.proposed)}`);
			if (d.verdict)
				console.error(
					`ruled    ${JSON.stringify(d.output)}${d.feedback ? `  — ${d.feedback}` : ""}`
				);
			for (const c of d.reasoning ?? [])
				console.error(`  ${c.supporting ? "✓" : "✕"} ${c.claim}`);
			console.log(d.evidence);
		})
	);

	// THE THREE THINGS A HUMAN DOES TO A JUDGMENT, from a shell. The same door the page uses,
	// so a card ruled here is ruled everywhere.
	//
	// THE ACTION IS A SUBCOMMAND, which is the same reason the wire takes a verb: a verdict cannot
	// be read off the payload, since an acceptance carries an answer and a refusal carries none —
	// and so does a card nobody has touched. `refuse` has no `--output` to give.

	const outputOf = (raw: string | undefined, what: string): unknown => {
		if (raw === undefined) return undefined;
		const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
		try {
			return JSON.parse(text);
		} catch (e) {
			throw new Error(
				`${what} is the verdict as JSON, or @file — ${e instanceof Error ? e.message : e}`
			);
		}
	};

	const said = (d: DecisionRow & { dispatched?: { taskId?: string; error?: string } }): void => {
		console.error(
			`#${d.id} ${d.verdict ?? "saved"}${d.feedback ? `  — ${d.feedback}` : ""}` +
				(d.dispatched?.error
					? `\n  the deed was not started: ${d.dispatched.error}`
					: d.dispatched?.taskId
						? `\n  carrying it out as ${d.dispatched.taskId} — \`flock task\` reads how it went`
						: "")
		);
		console.log(JSON.stringify(d, null, 2));
	};

	target(
		decision
			.command("save")
			.argument("<id>", "The decision, as `decision list` prints it.")
			.option("--output <json>", "The working copy, as JSON or @file.")
			.option("--note <text>", "What to write on it. Rules nothing.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description(
				"Save a working copy on a judgment. Rules nothing — the card stays in the deck."
			)
	).action(
		(
			id: string,
			opts: { dir?: string; app?: string; host?: string; output?: string; note?: string }
		) =>
			withApp(opts.dir, opts, async (host, appId) =>
				said(
					await decideCall<DecisionRow>(
						host,
						appId,
						"POST",
						`/${encodeURIComponent(id)}`,
						{
							action: "save",
							output: outputOf(opts.output, "--output"),
							feedback: opts.note
						}
					)
				)
			)
	);

	target(
		decision
			.command("accept")
			.argument("<id>", "The decision, as `decision list` prints it.")
			.requiredOption("--output <json>", "The verdict to commit, as JSON or @file.")
			.option("--note <text>", "A remark to keep beside it.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description(
				"Accept a judgment — THIS RUNS WHAT THE DECISION DOES, which for a reply is posting it."
			)
	).action(
		(
			id: string,
			opts: { dir?: string; app?: string; host?: string; output: string; note?: string }
		) =>
			withApp(opts.dir, opts, async (host, appId) =>
				said(
					await decideCall<DecisionRow>(
						host,
						appId,
						"POST",
						`/${encodeURIComponent(id)}`,
						{
							action: "accept",
							output: outputOf(opts.output, "--output"),
							feedback: opts.note
						}
					)
				)
			)
	);

	target(
		decision
			.command("refuse")
			.argument("<id>", "The decision, as `decision list` prints it.")
			.requiredOption("--note <text>", "Why. A refusal with no reason teaches nothing.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description(
				"Refuse a judgment. Nothing is dispatched, and whatever depended on it is refused too."
			)
	).action((id: string, opts: { dir?: string; app?: string; host?: string; note: string }) =>
		withApp(opts.dir, opts, async (host, appId) =>
			said(
				await decideCall<DecisionRow>(host, appId, "POST", `/${encodeURIComponent(id)}`, {
					action: "refuse",
					feedback: opts.note
				})
			)
		)
	);

	// ── crons ───────────────────────────────────────────────────────────────
	//
	// The same handlers the page's `/cron` door serves, behind the operator's credential —
	// so a schedule the CLI creates and one a page creates are the same row, read the same
	// way. What differs is only that an operator sees everyone's, while a viewer sees only
	// their own.

	const printCron = (c: CronRow): void => {
		const state = c.enabled ? "" : "  (disabled)";
		const last = c.lastStatus ? `  last ${c.lastStatus}` : "";
		const next = c.nextRunAt ? `  next ${c.nextRunAt}` : "  next —";
		console.log(`${c.id}  ${c.schedule}  ${c.task}${next}${last}${state}`);
		if (c.lastError) console.log(`    ${c.lastError.split("\n")[0]}`);
	};

	target(
		flock
			.command("cron")
			.argument("[dir]", "The app folder (default: the current directory).")
			.description("List the app's schedules — everyone's, since this is the owner's door.")
	).action((dir, opts) =>
		withApp(dir, opts, async (host, appId) => {
			const { crons } = await call<{ crons: CronRow[] }>(
				deps,
				host,
				"GET",
				`/api/apps/${appId}/cron`
			);
			if (!crons.length) {
				console.error("No schedules — `flock cron:add`.");
				return;
			}
			for (const c of crons) printCron(c);
		})
	);

	target(
		flock
			.command("cron:add")
			.argument("<name>", "Which task to run — `tasks/<name>.ts` in the app folder.")
			.argument("<schedule>", 'A 5-field cron expression, read as UTC (e.g. "0 9 * * *").')
			.argument("[args]", "Its arguments, as JSON. Default: {}")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description(
				"Schedule one of the app's tasks to run on a clock — or bring your schedule on it to this."
			)
			.addHelpText(
				"after",
				`
One schedule per task, per person: running this again for a task you already
schedule updates that schedule rather than adding a second one.

The schedule is UTC. There are no per-cron timezones, so "9am in Paris" is the UTC hour
you write here — and it stays that hour across a DST boundary rather than following one.

Nothing finer than every 5 minutes is accepted: that is how often the tick runs, and a
schedule that quietly ran 5x slower than it reads would be worse than a refused create.

It runs AS YOU. Its nested script runs land in your history and count against your quota,
exactly as a page's do for whoever is looking at it.

The first run is computed by the next tick, so \`cron:add\` never fires immediately. To
try one now, use \`flock cron:run <id>\`.

Examples:
  $ npx @reduck-ai/cli@latest flock cron:add digest "0 9 * * *"
  $ npx @reduck-ai/cli@latest flock cron:add refresh "*/15 * * * *" '{"full":true}'`
			)
	).action(
		(
			name: string,
			schedule: string,
			args: string | undefined,
			opts: { dir?: string; app?: string; host?: string }
		) =>
			withApp(opts.dir, opts, async (host, appId) => {
				let payload: unknown = {};
				if (args?.trim()) {
					try {
						payload = JSON.parse(args);
					} catch (e) {
						throw new Error(`arguments are not JSON: ${(e as Error).message}`);
					}
				}
				// PUT, keyed by the task: the same call an app's own setup step makes, so a schedule
				// set from a shell and one set from the page are the same row.
				const cron = await call<CronRow & { note?: string }>(
					deps,
					host,
					"PUT",
					`/api/apps/${appId}/cron`,
					{ task: name, schedule, args: payload }
				);
				if (cron.note) console.error(cron.note);
				console.log(cron.id);
			})
	);

	target(
		flock
			.command("cron:rm")
			.argument("<id>", "The schedule to delete, as printed by `flock cron`.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("Delete a schedule. The runs it already started are untouched.")
	).action((id: string, opts: { dir?: string; app?: string; host?: string }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			await call(deps, host, "DELETE", `/api/apps/${appId}/cron/${encodeURIComponent(id)}`);
			console.error(`Deleted ${id}.`);
		})
	);

	target(
		flock
			.command("cron:enable")
			.argument("<id>", "The schedule to switch on or off.")
			.option("--off", "Disable it instead.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("Switch a schedule on or off. Enabling also forgives its failure count.")
	).action((id: string, opts: { dir?: string; app?: string; host?: string; off?: boolean }) =>
		withApp(opts.dir, opts, async (host, appId) =>
			printCron(
				await call<CronRow>(
					deps,
					host,
					"PATCH",
					`/api/apps/${appId}/cron/${encodeURIComponent(id)}`,
					{ enabled: !opts.off }
				)
			)
		)
	);

	target(
		flock
			.command("cron:run")
			.argument("<id>", "The schedule to fire, as printed by `flock cron`.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("Fire a schedule now, without waiting for its next tick.")
			.addHelpText(
				"after",
				`
Use it to test a schedule without waiting for its next tick. It runs the task exactly as the clock would — same identity, same
\`context.trigger\` of "cron", same cron id — so what you see here is what you get.`
			)
	).action((id: string, opts: { dir?: string; app?: string; host?: string }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			const started = await call<{ taskId: string; task: string; skipped?: boolean }>(
				deps,
				host,
				"POST",
				`/api/apps/${appId}/cron/${encodeURIComponent(id)}/run`
			);
			console.error(`Started ${started.task} — it runs on its own from here.`);
			console.log(started.taskId);
		})
	);

	target(
		flock
			.command("sql")
			.argument(
				"[statement]",
				"One SQL statement. Omit it for a prompt, or pipe a script in on stdin."
			)
			.argument("[params...]", "Positional values for the statement's `?` placeholders.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option(
				"--file <path>",
				"Run a whole SQL script from a file — several statements, no rows back. A sequence, not a transaction: if one fails, the ones before it have landed. Take `db:download` first if that matters."
			)
			.option("--json", "Print the rows as JSON instead of a table.")
			.description("Run SQL against the app's database — the same door its page uses.")
			.addHelpText(
				"after",
				`
Examples:
  $ npx @reduck-ai/cli@latest flock sql "SELECT * FROM answers ORDER BY asked_at DESC LIMIT 5"
  $ npx @reduck-ai/cli@latest flock sql "DELETE FROM looks WHERE url = ?" https://example.com
  $ npx @reduck-ai/cli@latest flock sql --file add-column.sql
  $ echo "VACUUM;" | npx @reduck-ai/cli@latest flock sql
  $ npx @reduck-ai/cli@latest flock sql            # a prompt`
			)
	).action(
		(
			statement: string | undefined,
			params: string[],
			opts: { dir?: string; app?: string; host?: string; file?: string; json?: boolean }
		) =>
			withApp(opts.dir, opts, async (host, appId) => {
				if (opts.file) {
					// A file is a SCRIPT: several statements, run in order, nothing back
					// but success. The by-hand escape hatch — the ordinary way a schema
					// change lands is a new migration in the next release.
					await runStatement(deps, host, appId, {
						script: readFileSync(opts.file, "utf8")
					});
					console.error(`Ran ${opts.file}`);
					return;
				}
				if (!statement) {
					if (process.stdin.isTTY) return repl(deps, host, appId, !!opts.json);
					const piped = await readStdin();
					if (!piped.trim()) throw new Error("nothing on stdin and no statement given");
					await runStatement(deps, host, appId, { script: piped });
					console.error("Ran the script from stdin");
					return;
				}
				// Values parse as JSON when they can, so `id=5` binds a number and a bare
				// word binds a string — the same coercion `reduck run` uses for args.
				const bound = params.map((value) => {
					try {
						return JSON.parse(value);
					} catch {
						return value;
					}
				});
				printResult(
					await runStatement(deps, host, appId, { sql: statement, params: bound }),
					!!opts.json
				);
			})
	);

	target(
		flock
			.command("db")
			.argument("[dir]", "The app folder (default: the current directory).")
			.description("What is in the app's database: its tables, their row counts, its size.")
	).action((dir, opts) =>
		withApp(dir, opts, async (host, appId) => {
			const info = await call<DbInfo>(deps, host, "GET", `/api/apps/${appId}/db`);
			if (!info.exists) {
				console.error(
					"No database yet — it is created the first time the page runs a statement."
				);
				return;
			}
			console.log(`${humanBytes(info.bytes)} on disk`);
			for (const table of info.tables) console.log(`${table.name}\t${table.rows}`);
		})
	);

	target(
		flock
			.command("db:download")
			.argument("[path]", "Where to write it (default: <uuid>.sqlite here).")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description(
				"Download a consistent snapshot of the database — open it in sqlite3 or Datasette."
			)
	).action((path: string | undefined, opts: { dir?: string; app?: string; host?: string }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			const data = await download(deps, host, `/api/apps/${appId}/db/download`);
			const target = path ?? `${appId}.sqlite`;
			writeFileSync(target, data);
			console.error(`Wrote ${target} (${humanBytes(data.length)})`);
		})
	);

	target(
		flock
			.command("db:reset")
			.argument("[dir]", "The app folder (default: the current directory).")
			.option("--yes", "Skip the confirmation.")
			.description(
				"Delete the database and forget what it had applied. The next request climbs the release's migrations from empty — the way back when a migration cannot be the way forward."
			)
	).action((dir, opts: { yes?: boolean; app?: string; host?: string }) =>
		withApp(dir, opts, async (host, appId) => {
			if (!opts.yes) {
				console.error(
					`This deletes every row in ${host}/app/${appId}'s database — the blobs and config stay. ` +
						"Take a copy with `flock db:download` first, then re-run with --yes."
				);
				process.exitCode = 1;
				return;
			}
			await call(deps, host, "POST", `/api/apps/${appId}/db/reset`);
			console.error("Database reset — the next request climbs the migrations from empty.");
		})
	);

	target(
		flock
			.command("files")
			.argument("[prefix]", "Only keys starting with this.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option("--limit <n>", "How many keys at most (default 1000).")
			.description("List the app's blobs — what its /file door has stored.")
	).action(
		(
			prefix: string | undefined,
			opts: { dir?: string; app?: string; host?: string; limit?: string }
		) =>
			withApp(opts.dir, opts, async (host, appId) => {
				const query = new URLSearchParams({
					prefix: prefix ?? "",
					limit: opts.limit ?? "1000"
				});
				const { keys } = await call<{ keys: FileEntry[] }>(
					deps,
					host,
					"GET",
					`/api/apps/${appId}/files?${query}`
				);
				for (const entry of keys)
					console.log(
						`${entry.key}\t${humanBytes(entry.size)}\t${new Date(entry.modified * 1000).toISOString()}`
					);
				console.error(`${keys.length} blob(s)`);
			})
	);

	target(
		flock
			.command("files:get")
			.argument("<key>", "The blob's key, as `files` prints it.")
			.argument("[path]", "Where to write it. Omit to print it to stdout.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("Read one blob.")
	).action(
		(
			key: string,
			path: string | undefined,
			opts: { dir?: string; app?: string; host?: string }
		) =>
			withApp(opts.dir, opts, async (host, appId) => {
				const data = await raw(deps, host, "GET", `/api/apps/${appId}/files/${key}`);
				if (path) {
					writeFileSync(path, data);
					console.error(`Wrote ${path} (${humanBytes(data.length)})`);
				} else process.stdout.write(data);
			})
	);

	target(
		flock
			.command("files:put")
			.argument("<key>", "The key to store it under. Overwrites.")
			.argument("<path>", "The local file to upload.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("Write one blob at a key you choose.")
	).action((key: string, path: string, opts: { dir?: string; app?: string; host?: string }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			const body = readFileSync(path);
			const answer = await raw(deps, host, "PUT", `/api/apps/${appId}/files/${key}`, body);
			console.log((JSON.parse(answer.toString("utf8")) as { key: string }).key);
		})
	);

	target(
		flock
			.command("files:add")
			.argument("<path>", "The local file to store.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option("--ext <ext>", "Extension for the minted key (default: the file's, else txt).")
			.description(
				"Store a file content-addressed, the way the page's file.post does — the key is its sha256, so storing the same bytes twice stores them once."
			)
	).action((path: string, opts: { dir?: string; app?: string; host?: string; ext?: string }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			const ext = (opts.ext ?? path.split(".").pop() ?? "txt")
				.replace(/^\./, "")
				.toLowerCase();
			const answer = await raw(
				deps,
				host,
				"POST",
				`/api/apps/${appId}/files?ext=${encodeURIComponent(ext)}`,
				readFileSync(path)
			);
			const stored = JSON.parse(answer.toString("utf8")) as { key: string; deduped: boolean };
			console.error(stored.deduped ? "Already stored (same bytes)" : "Stored");
			console.log(stored.key);
		})
	);

	target(
		flock
			.command("files:rm")
			.argument("<keys...>", "The blob keys to delete.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("Delete blobs. A row still pointing at one will find it gone.")
	).action((keys: string[], opts: { dir?: string; app?: string; host?: string }) =>
		withApp(opts.dir, opts, async (host, appId) => {
			for (const key of keys) {
				const answer = await call<{ deleted: boolean }>(
					deps,
					host,
					"DELETE",
					`/api/apps/${appId}/files/${key}`
				);
				console.error(`${key}: ${answer.deleted ? "deleted" : "was not there"}`);
			}
		})
	);

	target(
		flock
			.command("secrets")
			.argument("[dir]", "The app folder (default: the current directory).")
			.description(
				"List the secret NAMES this app holds, and which of them a page may spend. Values never come back — that is the point."
			)
	).action((dir, opts) =>
		appScope(deps, dir, opts, async (handle, appId) => {
			const { secrets } = unwrap(
				await getAppSecrets({
					client: await appClient(deps),
					path: { handle, app_id: appId }
				}),
				`reading ${appId}'s secrets`
			);
			// The flag is shown on every line rather than only where it is set: "task-only" is
			// the default, and a reader scanning for what a browser can reach should not have to
			// know that absence means closed.
			console.log(printSecrets(secrets));
		})
	);

	target(
		flock
			.command("secrets:set")
			.argument(
				"<pairs...>",
				"NAME=VALUE — the values behind ${NAME} in the manifest's hosts."
			)
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.option(
				"--page",
				"Also let the PAGE spend these. Without it they are task-only: an app's server-side code may use every secret, a browser only what is opened here."
			)
	).action(
		(pairs: string[], opts: { dir?: string; app?: string; host?: string; page?: boolean }) =>
			appScope(deps, opts.dir, opts, async (handle, appId) => {
				const values = parsePairs(pairs, "secrets:set");
				// Always explicit, both ways. Sending `page_usable` even when the flag is absent is
				// what makes `secrets:set` idempotent: re-running it without --page CLOSES a secret
				// that had been opened, rather than quietly leaving the old answer in place.
				const body = Object.fromEntries(
					Object.entries(values).map(([name, value]) => [
						name,
						{ value, page_usable: Boolean(opts.page) }
					])
				);
				const { secrets } = unwrap(
					await updateAppSecrets({
						client: await appClient(deps),
						path: { handle, app_id: appId },
						body: { secrets: body }
					}),
					`setting ${appId}'s secrets`
				);
				console.error(
					`Set ${Object.keys(values).join(", ")} (${opts.page ? "page+task" : "task-only"})`
				);
				console.log(printSecrets(secrets));
			})
	);

	target(
		flock
			.command("secrets:page")
			.argument("<names...>", "Secret names to open to the page.")
			.option("--off", "Close them again — task-only.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description(
				"Open (or close) secrets to the PAGE without re-sending their values. A task may always spend every secret."
			)
	).action(
		(names: string[], opts: { dir?: string; app?: string; host?: string; off?: boolean }) =>
			appScope(deps, opts.dir, opts, async (handle, appId) => {
				// The reason this command exists at all: changing a boolean must not require
				// re-typing a credential, which is how one ends up in a shell history.
				const body = Object.fromEntries(
					names.map((name) => [name, { page_usable: !opts.off }])
				);
				const { secrets } = unwrap(
					await updateAppSecrets({
						client: await appClient(deps),
						path: { handle, app_id: appId },
						body: { secrets: body }
					}),
					`updating ${appId}'s secrets`
				);
				console.log(printSecrets(secrets));
			})
	);

	target(
		flock
			.command("secrets:unset")
			.argument("<names...>", "Secret names to remove.")
			.option("--dir <dir>", "The app folder (default: the current directory).")
			.description("Remove secrets from the app.")
	).action((names: string[], opts: { dir?: string; app?: string; host?: string }) =>
		appScope(deps, opts.dir, opts, async (handle, appId) => {
			const body: Record<string, null> = {};
			for (const name of names) body[name] = null;
			const { secrets } = unwrap(
				await updateAppSecrets({
					client: await appClient(deps),
					path: { handle, app_id: appId },
					body: { secrets: body }
				}),
				`removing ${appId}'s secrets`
			);
			console.log(printSecrets(secrets));
		})
	);

	target(
		flock
			.command("link")
			.argument("<uuid>", "The app to operate from this folder (from `flock apps`).")
			.option("--dir <dir>", "The folder to link it into (default: the current directory).")
			.description(
				"Point this folder's app-scoped commands at an existing install, without minting one."
			)
	).action((uuid: string, opts: { dir?: string; host?: string }) =>
		appScope(deps, undefined, { app: uuid, host: opts.host }, async (handle, appId) => {
			const dir = resolve(opts.dir ?? ".");
			writeLink(dir, {
				...readLink(dir),
				host: flockTarget(opts.host),
				app: { id: appId, handle }
			});
			console.error(`${linkPath(dir)} now points at ${handle}'s ${appId}`);
		})
	);

	target(
		flock
			.command("releases")
			.argument("[dir]", "The image folder (default: the current directory).")
			.description("What this image has shipped, newest first.")
	).action((dir, opts) =>
		imageScope(deps, dir, opts, async (handle, slug) => {
			const releases = unwrap(
				await listAppImageReleases({
					client: await appClient(deps),
					path: { handle, slug },
					query: { page_size: 100 }
				}),
				`reading ${handle}/${slug}'s releases`
			);
			for (const release of releases.data) {
				console.log(
					[
						`v${release.number}`,
						release.published_at ?? "never finished uploading",
						release.current ? "← serving" : ""
					]
						.filter(Boolean)
						.join("\t")
				);
			}
		})
	);

	target(
		flock
			.command("rollback")
			.argument("<release>", "The release number to serve (from `releases`).")
			.option("--dir <dir>", "The image folder (default: the current directory).")
			.description(
				"Serve an earlier release, to every install at once. A pointer move — the bytes are still there."
			)
	).action((release: string, opts: { dir?: string; host?: string }) =>
		imageScope(deps, opts.dir, opts, async (handle, slug) => {
			const image = unwrap(
				await rollbackAppImage({
					client: await appClient(deps),
					path: { handle, slug },
					body: { release: Number(release) }
				}),
				`rolling ${handle}/${slug} back to v${release}`
			);
			// Not "serving v1 to N installs": one whose database has already climbed past v1 stays
			// where it is, because nothing says how to unmigrate it. Saying so is the difference
			// between a rollback you can trust and one that quietly reached half of them.
			console.error(
				`Now serving v${image.current_release}` +
					(image.install_count
						? `. Of ${image.install_count} install(s), the ones that never ran a ` +
							`migration above it follow on their next load; any whose tables have ` +
							`moved past it stay where they are.`
						: " — nothing is installed from it yet.")
			);
		})
	);

	target(
		flock
			.command("destroy")
			.argument("[dir]", "The app folder (default: the current directory).")
			.option("--yes", "Skip the confirmation.")
			.description("Delete the app, its blobs and its database. There is no undo.")
	).action((dir, opts: { yes?: boolean; app?: string; host?: string }) =>
		withApp(dir, opts, async (host, appId) => {
			if (!opts.yes) {
				console.error(
					`This deletes ${host}/app/${appId} — its records, its blobs and every release. ` +
						"Re-run with --yes if that is what you want."
				);
				process.exitCode = 1;
				return;
			}
			const out = await call<{ objects: number }>(deps, host, "DELETE", `/api/apps/${appId}`);
			console.error(`Destroyed ${appId} (${out.objects} object(s) removed)`);
		})
	);
}
