// The compile entry for bun build --compile. The web assets are
// pre-built by scripts/build.ts and embedded here as text, so the
// binary never reads web sources from disk. The dev tree does not
// use this file; bun runs main.ts directly.

import appJs from "../../web/dist/app.js.txt" with { type: "text" };
import indexHtml from "../../web/dist/index.html.txt" with { type: "text" };
import { setEmbeddedAssets } from "../../server/src/http.ts";

setEmbeddedAssets({ indexHtml, appJs });
await import("./main.ts");
