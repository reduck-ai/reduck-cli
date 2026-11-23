import { execFile } from "node:child_process";

// The URL is passed as an argument vector, never as a shell string: it can be built from data
// this client did not write (a discovered `authorization_endpoint`, a linked folder's config), and
// a shell would read the quoting and the metacharacters in it as its own.
export function openBrowser(url: string): void {
	if (process.platform === "darwin") execFile("open", [url]);
	// Not `cmd /c start`: cmd parses its own arguments, so & or ^ in the URL would act on it.
	else if (process.platform === "win32") execFile("rundll32", ["url.dll,FileProtocolHandler", url]);
	else execFile("xdg-open", [url]);
}
