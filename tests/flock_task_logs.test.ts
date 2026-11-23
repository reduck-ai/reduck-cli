// WHICH STREAM CARRIES WHAT, for the one command that reads a run back.
//
// `task:logs` has two shapes over one read, and the difference is stdout alone:
//
//   bare      the log lines, one per line          → `| grep`, `> file`
//   --json    the whole record, result included    → `| jq .result`
//
// Both put the verdict on stderr and both exit 1 on a failed run, because that is what a caller
// composes on either way.
//
// THE CONTRACT IS THE THING WORTH PINNING, not the flag: the code is four lines and cannot really
// break, while "stdout is pure JSON" is exactly what a later tidy-up breaks invisibly — a stray
// console.log, or logs echoed alongside the document that already holds them, and somebody's
// `| jq` dies in a pipeline far from the edit.
//
// The door is stubbed on loopback: this is about what the CLI does with an answer, not about
// getting one. `REDUCK_API_KEY` short-circuits OAuth (`resourceAuth` in index.ts), so nothing here
// needs a credential or a network. Driven from `src/` through tsx, so a stale `dist/` cannot answer.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "src", "index.ts");
const APP = "00000000-0000-4000-8000-000000000000";

// One run, as `/task/<id>` answers it: something on every field the two shapes read.
const RECORD = {
	taskId: "0123456789abcdef0123456789abcdef",
	task: "daily",
	status: "ok",
	startedAt: "2026-09-04T10:51:14.808Z",
	finishedAt: "2026-09-04T10:52:46.900Z",
	result: { count: 2 },
	logs: ["step 1", "step 2"]
};

let host = "";
let server: Server | undefined;

// The id decides what the stub answers, so one route serves both cases and the test names which it
// wants at the call site.
const FAILED = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";

before(async () => {
	server = createServer((req, res) => {
		const id = (req.url ?? "").split("/").pop() ?? "";
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify(
				id === FAILED
					? { ...RECORD, taskId: FAILED, status: "error", error: "the pool was full" }
					: RECORD
			)
		);
	});
	await new Promise<void>((ready) => server?.listen(0, "127.0.0.1", ready));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	host = `http://127.0.0.1:${address.port}`;
});

after(() => server?.close());

const logs = (id: string, ...flags: string[]) =>
	exec(
		process.execPath,
		["--import", "tsx", CLI, "flock", "task:logs", id, "--app", APP, "--host", host, ...flags],
		{
			env: { ...process.env, REDUCK_API_KEY: "test", REDUCK_EXPERIMENTAL: "1" }
		}
	);

test("bare, stdout is the log lines and nothing else", async () => {
	const { stdout, stderr } = await logs(RECORD.taskId);
	assert.deepEqual(stdout.trimEnd().split("\n"), RECORD.logs);
	assert.match(stderr, /daily ok/);
});

test("--json, stdout is the whole record — which is the only way to read a result back", async () => {
	const { stdout, stderr } = await logs(RECORD.taskId, "--json");
	// Parses WHOLE, so a stray line printed beside it fails here rather than in somebody's pipeline.
	const state = JSON.parse(stdout);
	assert.deepEqual(state.result, RECORD.result);
	assert.deepEqual(state.logs, RECORD.logs);
	// The lines are in the document; repeating them on stderr would be noise made of content the
	// caller already holds.
	assert.equal(stderr.includes(RECORD.logs[0] ?? ""), false);
	assert.match(stderr, /daily ok/);
});

test("a failed run exits 1 and says why on stderr, in both shapes", async () => {
	for (const flags of [[], ["--json"]]) {
		const failure = await logs(FAILED, ...flags).catch(
			(e: { code: number; stderr: string }) => e
		);
		assert.equal("code" in failure && failure.code, 1, `--json: ${flags.length > 0}`);
		assert.match(failure.stderr, /the pool was full/);
	}
});
