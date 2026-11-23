// Headers and sign-in parameters the environment asks every request to carry: for a Reduck
// server behind a gateway that wants a header of its own. Never set by default.
//
//   REDUCK_EXTRA_HEADERS       a JSON object of headers, sent with every request
//   REDUCK_EXTRA_AUTH_PARAMS   a JSON object of query parameters, added to the sign-in URL the
//                              browser opens (a browser leg cannot carry a header)
//
// Their own module, so both command families read them without importing each other.

function refuse(message: string): never {
	console.error(`error: ${message}`);
	process.exit(2);
}

function jsonObject(name: string): Record<string, string> {
	const raw = process.env[name]?.trim();
	if (!raw) return {};
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		refuse(`${name} is not JSON: give an object, e.g. {"x-name":"value"}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		refuse(`${name} must be a JSON object of strings`);
	return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)]));
}

const HEADERS = jsonObject("REDUCK_EXTRA_HEADERS");
const AUTH_PARAMS = jsonObject("REDUCK_EXTRA_AUTH_PARAMS");

export const extraHeaders = (): Record<string, string> => ({ ...HEADERS });

export const extraAuthParams = (): Record<string, string> => ({ ...AUTH_PARAMS });
