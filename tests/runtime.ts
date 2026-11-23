// The flock page runtime the tests build and run apps against: the files a flock host serves
// under /client/. $FLOCK_RUNTIME_DIR names a folder that holds them; without it, they are
// downloaded once from $REDUCK_FLOCK_URL (default https://flock.reduck.ai) into tests/.runtime.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function download(host: string, dir: string): Promise<void> {
	const get = async (name: string) => {
		const res = await fetch(`${host}/client/${name}`);
		if (!res.ok) throw new Error(`GET ${host}/client/${name} → ${res.status}`);
		return Buffer.from(await res.arrayBuffer());
	};
	const manifest = await get("manifest.json");
	const { files } = JSON.parse(manifest.toString()) as { files: string[] };
	mkdirSync(dir, { recursive: true });
	for (const name of files) writeFileSync(join(dir, name), await get(name));
	writeFileSync(join(dir, "manifest.json"), manifest);
}

async function resolveRuntime(): Promise<string> {
	const given = process.env.FLOCK_RUNTIME_DIR?.trim();
	if (given) return given;
	const dir = join(import.meta.dirname, ".runtime");
	if (!existsSync(join(dir, "manifest.json"))) {
		const host = (process.env.REDUCK_FLOCK_URL?.trim() || "https://flock.reduck.ai").replace(/\/+$/, "");
		await download(host, dir);
	}
	return dir;
}

export const RUNTIME = await resolveRuntime();
