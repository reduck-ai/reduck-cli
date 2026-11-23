// A REFUSED LOOKUP IS NOT AN ABSENT IMAGE.
//
// `deploy` asks the app for the image, and creates it when there is none. "None" is a 404 and
// nothing else: a 401, a 403 or a protection page is the app refusing to say, and a deploy that
// read that as absence would create the image on whichever host had refused it, which need not
// be the host the folder is linked to.
//
// So the contract pinned here is what a person sees and what the app receives:
//
//   lookup → 401   exit 1, the HOST and the status in the sentence, and NO create request
//   lookup → 404   the create goes out, and the line that reports it names the host
//   upload dropped once   tried again, and the release publishes
//   upload dropped always the file, the storage host, the transport's reason, how many attempts,
//                         and the reserved release
//
// One loopback server plays both the flock host (`/client/*`, the runtime of tests/runtime.ts) and the
// app (`/api/app-images/*`). `REDUCK_API_KEY` short-circuits OAuth (`resourceAuth` in index.ts)
// and `--project` names the scope, so nothing here needs a credential, `/api/me`, or a network.
// Driven from `src/` through tsx, so a stale `dist/` cannot answer.

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
const ESBUILD = join(import.meta.dirname, "..", "node_modules", ".bin", "esbuild");
// The runtime as a host serves it: the manifest names the files, each file is fetched by name.
const CLIENT_FILES = JSON.stringify({
	files: [
		"index.js",
		"sdk.js",
		"doors.js",
		"util.js",
		"task.js",
		"router.js",
		"contract.js",
		"judging.js",
		"run.js",
		"evidence.js"
	]
});

let tmp: string;
let host = "";
let server: Server | undefined;
// What the app answers a lookup with, and every request it then received — set per test.
let lookup: { status: number; body: unknown } = { status: 404, body: { error: "Not found" } };
let seen: string[] = [];
// How many PUTs the storage drops before it takes one — set per test.
let drops = Infinity;

before(async () => {
	tmp = mkdtempSync(join(tmpdir(), "flock-deploy-"));
	const app = join(tmp, "probe");
	mkdirSync(join(app, "migrations"), { recursive: true });
	writeFileSync(
		join(app, "manifest.json"),
		JSON.stringify({ slug: "probe", name: "probe", config: {}, secrets: {}, hosts: {} })
	);
	writeFileSync(join(app, "migrations", "001-initial.sql"), "-- nothing to store\n");
	// A page that imports nothing: this is about what deploy does AFTER the build.
	writeFileSync(join(app, "front.jsx"), "console.log('probe');\n");

	server = createServer((req, res) => {
		const url = req.url ?? "";
		if (url.startsWith("/client/")) {
			const name = url.replace(/^\/client\//, "");
			try {
				res.end(
					name === "manifest.json" ? CLIENT_FILES : readFileSync(join(RUNTIME, name))
				);
			} catch {
				res.statusCode = 404;
				res.end();
			}
			return;
		}
		seen.push(`${req.method} ${url}`);
		res.setHeader("content-type", "application/json");
		if (req.method === "GET" && url === "/api/app-images/acme/probe") {
			res.statusCode = lookup.status;
			res.end(JSON.stringify(lookup.body));
			return;
		}
		if (req.method === "POST" && url === "/api/app-images/acme") {
			res.statusCode = 201;
			res.end(JSON.stringify({ slug: "probe", owner: { handle: "acme" } }));
			return;
		}
		// A release hands out one presigned PUT per file; this one's connection is dropped, as a
		// flaky network can do to any upload.
		if (req.method === "POST" && url === "/api/app-images/acme/probe/releases") {
			res.statusCode = 201;
			res.end(
				JSON.stringify({
					number: 7,
					uploads: [{ name: "app.js", url: `${host}/upload/app.js`, headers: {} }]
				})
			);
			return;
		}
		if (req.method === "PUT" && url.startsWith("/upload/")) {
			if (drops-- > 0) {
				req.socket.destroy();
				return;
			}
			req.resume();
			req.on("end", () => res.end());
			return;
		}
		if (req.method === "POST" && url === "/api/app-images/acme/probe/releases/7/publish") {
			res.end(JSON.stringify({ current_release: 7, install_count: 0 }));
			return;
		}
		// Anything past the create is not this test's subject: refuse it, so the run ends there.
		res.statusCode = 500;
		res.end(JSON.stringify({ error: "stub: not this test's subject" }));
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

// The deploy, as a person runs it; resolves with what it printed whether it succeeded or not.
const deploy = async () => {
	seen = [];
	try {
		const out = await exec(
			process.execPath,
			[
				"--import",
				"tsx",
				CLI,
				"flock",
				"deploy",
				join(tmp, "probe"),
				"--project",
				"acme",
				"--host",
				host,
				"--esbuild",
				ESBUILD
			],
			{
				env: {
					...process.env,
					HOME: tmp,
					REDUCK_EXPERIMENTAL: "1",
					REDUCK_API_KEY: "reduck_test",
					REDUCK_APP_URL: host
				}
			}
		);
		return { code: 0, stderr: out.stderr };
	} catch (e) {
		const failed = e as { code?: number; stderr?: string };
		return { code: failed.code ?? 1, stderr: failed.stderr ?? "" };
	}
};

test("a refused lookup creates nothing, and the error names the host that refused", async () => {
	lookup = { status: 401, body: { error: "invalid or unauthorized API key" } };
	const { code, stderr } = await deploy();
	assert.equal(code, 1);
	assert.match(
		stderr,
		new RegExp(
			`reading acme/probe → ${host.replace("http://", "")} 401: invalid or unauthorized API key`
		)
	);
	assert.ok(seen.includes("GET /api/app-images/acme/probe"), "the lookup went out");
	assert.deepEqual(
		seen.filter((r) => !r.startsWith("GET ")),
		[],
		"and nothing was written after it"
	);
});

test("an absent image is a 404, and the create names the host it landed on", async () => {
	lookup = { status: 404, body: { error: "Not found" } };
	const { stderr } = await deploy();
	assert.deepEqual(seen.filter((r) => r.includes("/api/app-images/")).slice(0, 2), [
		"GET /api/app-images/acme/probe",
		"POST /api/app-images/acme"
	]);
	assert.match(stderr, new RegExp(`Created image acme/probe on ${host.replace("http://", "")}`));
});

test("an upload dropped once is tried again, and the release publishes", async () => {
	lookup = { status: 200, body: { slug: "probe", owner: { handle: "acme" } } };
	drops = 1;
	const { code, stderr } = await deploy();
	assert.equal(code, 0, stderr);
	assert.equal(seen.filter((r) => r === "PUT /upload/app.js").length, 2);
	assert.match(stderr, /Deployed acme\/probe v7/);
});

test("a dropped upload names the file, the host, the reason, and the release it reserved", async () => {
	lookup = { status: 200, body: { slug: "probe", owner: { handle: "acme" } } };
	drops = Infinity;
	const { code, stderr } = await deploy();
	assert.equal(code, 1);
	assert.equal(seen.filter((r) => r === "PUT /upload/app.js").length, 4);
	assert.match(
		stderr,
		new RegExp(
			`uploading app\\.js: could not reach ${host}: fetch failed \\(.+\\), after 4 attempts\\. v7 was reserved`
		)
	);
});
