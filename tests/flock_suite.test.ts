// `flock test` RUNS AN APP'S OFFLINE SUITE WHEREVER THE FOLDER LIVES.
//
// A suite imports "flock" and "flock/testing" as bare specifiers, and a folder outside this
// checkout has no package that answers them. `flock test` fetches the runtime and the test kit
// from the host, then points those imports at the copy it cached. This holds it to that, on a
// loopback host that serves the runtime of tests/runtime.ts the way a host does:
//
//   pnpm test
//
// The case that opens a database is skipped below Node 24.15. The kit refuses to run there,
// because node:sqlite ignores the limits the host enforces before that version.
//
// Drives the CLI from `src/` through tsx rather than `dist/`, so a stale build cannot answer.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "src", "index.ts");
import { RUNTIME } from "./runtime.ts";

// What a flock host lists at /client/manifest.json.
const SERVED = [
	"index.js",
	"sdk.js",
	"router.js",
	"doors.js",
	"util.js",
	"task.js",
	"contract.js",
	"judging.js",
	"run.js",
	"evidence.js",
	"harness.mjs"
];

const [major, minor] = process.versions.node.split(".").map(Number);
const kitRuns = major > 24 || (major === 24 && minor >= 15);

let tmp: string;
let host: string;
let server: Server | undefined;

/** An app folder beside the others, so the toolchain above it is `apps/node_modules`. */
const app = (name: string, tests: Record<string, string>): string => {
	const dir = join(tmp, "apps", name);
	mkdirSync(join(dir, "migrations"), { recursive: true });
	mkdirSync(join(dir, "tests"), { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ slug: name, name, config: {}, secrets: {}, hosts: {} })
	);
	writeFileSync(
		join(dir, "migrations", "001-initial.sql"),
		"CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n"
	);
	for (const [file, body] of Object.entries(tests)) writeFileSync(join(dir, "tests", file), body);
	return dir;
};

const flockTest = (dir: string, at = host) =>
	exec(process.execPath, ["--import", "tsx", CLI, "flock", "test", dir, "--host", at], {
		env: { ...process.env, HOME: tmp, REDUCK_EXPERIMENTAL: "1" }
	});

before(async () => {
	tmp = mkdtempSync(join(tmpdir(), "flock-suite-"));
	// The toolchain the runtime is cached in. Empty is enough: nothing below imports react.
	mkdirSync(join(tmp, "apps", "node_modules"), { recursive: true });

	// `/old/…` is a host whose manifest does not list the test kit.
	const listing = (files: string[]) => JSON.stringify({ files });
	server = createServer((req, res) => {
		const url = req.url ?? "";
		const old = url.startsWith("/old/");
		const name = url.replace(/^(\/old)?\/client\//, "");
		try {
			if (name === "manifest.json")
				res.end(listing(old ? SERVED.filter((f) => f !== "harness.mjs") : SERVED));
			else res.end(readFileSync(join(RUNTIME, name)));
		} catch {
			res.statusCode = 404;
			res.end();
		}
	});
	await new Promise<void>((ready) => server?.listen(0, "127.0.0.1", ready));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	host = `http://127.0.0.1:${address.port}`;
});

after(() => {
	server?.close();
	rmSync(tmp, { recursive: true, force: true });
});

test("a suite's flock imports reach the host's runtime and test kit", async () => {
	const dir = app("imports", {
		"imports.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
import { insert } from "flock";
import { makeDoors } from "flock/testing";
import * as harness from "flock/harness";
test("resolved", () => {
	assert.equal(typeof insert, "function");
	assert.equal(typeof makeDoors, "function");
	assert.equal(harness.makeDoors, makeDoors);
});
`,
		// A helper module beside the tests: node --test must not run it as a test of its own.
		"fixtures.mjs": `throw new Error("a helper module ran as a test");\n`
	});
	const { stdout } = await flockTest(dir);
	assert.match(stdout, /resolved/);
});

test("a failing suite fails the command", async () => {
	const dir = app("fails", {
		"fails.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
test("wrong", () => assert.equal(1, 2));
`
	});
	await assert.rejects(flockTest(dir), (e: { code?: number }) => e.code === 1);
});

test("a host that serves no test kit is named, and nothing runs", async () => {
	const dir = app("old-host", {
		"never.test.mjs": `throw new Error("the suite ran against a host with no test kit");\n`
	});
	await assert.rejects(flockTest(dir, `${host}/old`), (e: { stderr?: string }) =>
		/serves no test kit/.test(e.stderr ?? "")
	);
});

test(
	"makeDoors gives the doors of the app over its own migrations",
	{ skip: kitRuns ? false : `the kit needs Node 24.15; this is ${process.versions.node}` },
	async () => {
		const dir = app("notes", {
			"notes.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDoors } from "flock/testing";
test("a note is stored", async () => {
	const h = makeDoors({ appDir: new URL("..", import.meta.url).pathname });
	await h.doors.insert("notes", { body: "hello" });
	assert.equal(h.sql("SELECT body FROM notes")[0].body, "hello");
});
`
		});
		const { stdout } = await flockTest(dir);
		assert.match(stdout, /a note is stored/);
	}
);
