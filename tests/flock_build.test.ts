// ONE REACT IN THE PAGE BUNDLE, whatever sits above the app folder.
//
// `deploy` bundles the host's client runtime (`router.js` imports react) together with the app
// (`front.jsx` imports react), and esbuild resolves each bare import by walking up from the FILE
// that made it. So the runtime has to be cached inside the app's own toolchain, or the two walks
// climb different trees and the page ships two Reacts — every hook then dies with
// `Cannot read properties of null (reading 'useSyncExternalStore')`.
//
// This builds both trees an app can meet and holds the bundle to ONE react:
//
//   tmp/node_modules/react           MARK "react-B" — a copy above everything, where ~ would be
//   tmp/apps/node_modules/react      MARK "react-A" — the toolchain beside the app
//   tmp/apps/my-app/front.jsx        imports react and flock/router
//
// HOME is the temp folder, so a CLI that caches the runtime under the home directory walks into
// the trap on its own and ships react-B. The runtime comes from tests/runtime.ts (REDUCK_FLOCK_URL
// or FLOCK_RUNTIME_DIR) and is served on a loopback port, the same files a host serves, unless
// FLOCK_URL names a live host:
//
//   pnpm test
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
const ESBUILD = join(import.meta.dirname, "..", "node_modules", ".bin", "esbuild");

// What `router.js` imports from react, so the stub resolves as a module esbuild can bundle. The
// marker is a TOP-LEVEL SIDE EFFECT and not an export: the runtime imports three hooks and
// nothing else, so an exported string in the copy it pulled in is dead code — tree-shaken out of
// the bundle, and the copy it names bundled anyway, unseen (two react sources in the bundle,
// one marker).
const react = (mark: string) =>
	`globalThis.__reacts = [...(globalThis.__reacts ?? []), ${JSON.stringify(mark)}];
export const MARK = ${JSON.stringify(mark)};
export const createElement = () => null;
export const useMemo = (f) => f();
export const useSyncExternalStore = () => "";
`;

const pkg = (dir: string, name: string, files: Record<string, string>) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name, type: "module", main: "index.js" })
	);
	for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
};

let tmp: string;
let host: string;
let server: Server | undefined;

before(async () => {
	tmp = mkdtempSync(join(tmpdir(), "flock-build-"));

	pkg(join(tmp, "node_modules", "react"), "react", { "index.js": react("react-B") });
	pkg(join(tmp, "apps", "node_modules", "react"), "react", { "index.js": react("react-A") });
	pkg(join(tmp, "apps", "node_modules", "react-dom"), "react-dom", {
		"index.js": "",
		"client.js": "export const createRoot = () => ({ render() {} });"
	});

	const app = join(tmp, "apps", "my-app");
	mkdirSync(join(app, "migrations"), { recursive: true });
	writeFileSync(
		join(app, "manifest.json"),
		JSON.stringify({ slug: "probe", name: "probe", config: {}, secrets: {}, hosts: {} })
	);
	writeFileSync(join(app, "migrations", "001-initial.sql"), "-- a page and nothing to store\n");
	writeFileSync(
		join(app, "front.jsx"),
		`import { MARK } from "react";
import { createRoot } from "react-dom/client";
import { useRoute } from "flock/router";
console.log(MARK, useRoute);
createRoot(document.body).render(null);
`
	);

	host = process.env.FLOCK_URL ?? "";
	if (!host) {
		// The runtime as a host serves it: the manifest names the files, each file is fetched by name.
		const manifest = JSON.stringify({
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
		server = createServer((req, res) => {
			const name = (req.url ?? "").replace(/^\/client\//, "");
			try {
				res.end(name === "manifest.json" ? manifest : readFileSync(join(RUNTIME, name)));
			} catch {
				res.statusCode = 404;
				res.end();
			}
		});
		await new Promise<void>((ready) => server?.listen(0, "127.0.0.1", ready));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no port");
		host = `http://127.0.0.1:${address.port}`;
	}
});

after(() => {
	server?.close();
	rmSync(tmp, { recursive: true, force: true });
});

test("the page bundle holds the toolchain's react once, and never the copy above it", async () => {
	const out = join(tmp, "out");
	await exec(
		process.execPath,
		[
			"--import",
			"tsx",
			CLI,
			"flock",
			"build",
			join(tmp, "apps", "my-app"),
			"--out",
			out,
			"--host",
			host,
			"--esbuild",
			ESBUILD
		],
		{ env: { ...process.env, HOME: tmp, REDUCK_EXPERIMENTAL: "1" } }
	);
	const bundle = readFileSync(join(out, "app.js"), "utf8");
	// One react MODULE, counted by the side effect every copy runs at load, then which one.
	assert.equal(
		bundle.split("globalThis.__reacts = ").length - 1,
		1,
		"exactly one react is bundled"
	);
	assert.equal(bundle.includes("react-A"), true, "and it is the toolchain's");
	assert.equal(
		bundle.includes("react-B"),
		false,
		"the copy above the toolchain never reaches the bundle"
	);
});
