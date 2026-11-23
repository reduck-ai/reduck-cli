import { randomBytes } from "node:crypto";
import { copyFile, link, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";

// Downloads happen in the browser, which runs here on the local machine. This
// must match the folder where the Reduck browser extension saves downloads: a
// run's result names its files by a path under it.
export const DOWNLOADS_DIR = "/tmp/reduck-downloads";

// ── Caller-side delivery ────────────────────────────────────────────────────
// Downloads are persisted GUID-named under DOWNLOADS_DIR: the device writes the
// file but can't know its real name (that lives in the download's protocol
// metadata, surfaced to the caller as `filename`). The caller is the only actor
// holding both the file and its name on the same machine, so it consummates the
// envelope here — moving each artifact to destDir under its real name, with
// Chrome-style " (n)" collision suffixing, and rewriting the in-result `path`.
//
// Runs on the device's own machine, so path.* speaks the right separator and
// matching is by directory containment, never a hardcoded "/". A path it can't
// recognize (e.g. a foreign-OS string) simply passes through unrelocated.

const isUnder = (p: string, dir: string): boolean => {
	const rel = relative(dir, p);
	return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
};

// The run's `download` already awaited completion (dl.failure()), so the
// download itself is done by the time we see the result. This guard covers only
// the remaining local gap: the device's fs.watch copies the finished artifact
// into DOWNLOADS_DIR asynchronously and not necessarily atomically. So wait for
// the file to appear *and* its size to settle before moving it. Returns false if
// it never lands (caller fails loud).
const settled = async (p: string, timeoutMs = 30_000): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	let last = -1;
	while (Date.now() < deadline) {
		const size = await stat(p).then(
			(s) => s.size,
			() => -1
		);
		if (size >= 0 && size === last) return true; // exists and unchanged across two ticks
		last = size;
		await new Promise((r) => setTimeout(r, 150));
	}
	return false;
};

// Atomically move src → dest, refusing to clobber: link (same volume, no copy)
// else copyFile with COPYFILE_EXCL (cross volume). Returns false if dest is
// already taken so the caller can bump the " (n)" suffix. The *exclusive create*
// is what makes concurrent deliveries race-free — a check-then-move would let
// two files claim the same name and one would silently overwrite the other.
const moveExcl = async (src: string, dest: string): Promise<boolean> => {
	try {
		try {
			await link(src, dest);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
			await copyFile(src, dest, constants.COPYFILE_EXCL);
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	}
	await unlink(src);
	return true;
};

// Deliver src into dir, Chrome-style: "Invoice.pdf", then "Invoice (1).pdf",
// "Invoice (2).pdf" … at the first slot we can claim atomically.
const deliver = async (src: string, dir: string, name: string): Promise<string> => {
	const ext = extname(name);
	const stem = basename(name, ext);
	for (let n = 0; ; n++) {
		const dest = join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
		if (await moveExcl(src, dest)) return dest;
	}
};

// Walk a script result; relocate every artifact whose `path` sits under
// DOWNLOADS_DIR to destDir, rewriting `path` to the delivered location. Anything
// else passes through untouched. Returns the rewritten result.
export async function deliverDownloads(result: unknown, destDir: string): Promise<unknown> {
	let made = false;
	const walk = async (node: unknown): Promise<unknown> => {
		if (Array.isArray(node)) return Promise.all(node.map(walk));
		if (node && typeof node === "object") {
			const obj = node as Record<string, unknown>;
			if (typeof obj.path === "string" && isUnder(obj.path, DOWNLOADS_DIR)) {
				if (!(await settled(obj.path)))
					throw new Error(`download never materialized at ${obj.path} (timed out)`);
				if (!made) {
					await mkdir(destDir, { recursive: true });
					made = true;
				}
				const name = typeof obj.filename === "string" ? obj.filename : basename(obj.path);
				return { ...obj, path: await deliver(obj.path, destDir, name) };
			}
			// Cloud-browser envelope: the bytes live behind a link, not on any disk
			// we can reach. Fetch them here so a managed run
			// ends exactly like a local one — a file in destDir under its real name.
			if (
				typeof obj.url === "string" &&
				typeof obj.filename === "string" &&
				!("path" in obj)
			) {
				const res = await fetch(obj.url);
				if (!res.ok) throw new Error(`download ${obj.url} → HTTP ${res.status}`);
				if (!made) {
					await mkdir(destDir, { recursive: true });
					made = true;
				}
				const tmp = join(destDir, `.dl-${randomBytes(6).toString("hex")}`);
				await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
				return { ...obj, path: await deliver(tmp, destDir, obj.filename) };
			}
			return Object.fromEntries(
				await Promise.all(Object.entries(obj).map(async ([k, v]) => [k, await walk(v)]))
			);
		}
		return node;
	};
	return walk(result);
}
