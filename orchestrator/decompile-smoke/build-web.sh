#!/usr/bin/env bash
# Production web build of the smoke client: the mockup's inline script plus the API client, bundled
# and minified into dist/, exactly as a static host would serve it.
set -euo pipefail
cd "$(dirname "$0")"
mockup=../../spec/mockup
rm -rf dist build && mkdir dist build
cp sync.js build/sync.js
API_URL=${STACKARENA_API_URL:-http://localhost:8080} MOCKUP=$mockup bun -e '
const html = await Bun.file(`${process.env.MOCKUP}/index.html`).text();
const [head, rest] = html.split("<script>");
const [script, tail] = rest.split("</script>");
await Bun.write("build/config.js", `export const API_URL = ${JSON.stringify(process.env.API_URL)};\n`);
await Bun.write("build/entry.js", `import * as api from "./sync.js";\nglobalThis.stackarenaApi = api;\n${script}`);
await Bun.write("dist/index.html", `${head}<script type="module" src="app.js"></script>${tail}`);
'
bun build build/entry.js --minify --outfile dist/app.js
cp "$mockup"/*.woff2 "$mockup"/*.svg dist/
rm -rf build
