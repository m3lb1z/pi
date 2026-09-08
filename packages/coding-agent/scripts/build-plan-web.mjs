import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = resolve(packageDir, "src/core/plan-web/vendor");

await mkdir(outputDir, { recursive: true });
await build({
	entryPoints: [resolve(packageDir, "src/core/plan-web/frontend.jsx")],
	bundle: true,
	define: { "process.env.NODE_ENV": '"production"' },
	format: "iife",
	legalComments: "none",
	loader: { ".jsx": "jsx" },
	minify: true,
	outfile: resolve(outputDir, "app.js"),
	platform: "browser",
	target: ["es2022"],
});
