// The compile entry for bun build --compile. The web assets are
// pre-built by scripts/build.ts and embedded here as text, so the
// binary never reads web sources from disk. Font imports use Bun's
// file loader so they live in the compiled executable too. The dev
// tree does not use this file; bun runs main.ts directly.

import appJs from "../../web/dist/app.js.txt" with { type: "text" };
import indexHtml from "../../web/dist/index.html.txt" with { type: "text" };
import googleSans400 from "../../web/public/fonts/google-sans-400.woff2" with { type: "file" };
import googleSans500 from "../../web/public/fonts/google-sans-500.woff2" with { type: "file" };
import googleSans600 from "../../web/public/fonts/google-sans-600.woff2" with { type: "file" };
import googleSans700 from "../../web/public/fonts/google-sans-700.woff2" with { type: "file" };
import { setEmbeddedAssets } from "../../server/src/http.ts";

setEmbeddedAssets({
  indexHtml,
  appJs,
  fonts: {
    "/fonts/google-sans-400.woff2": Bun.file(googleSans400),
    "/fonts/google-sans-500.woff2": Bun.file(googleSans500),
    "/fonts/google-sans-600.woff2": Bun.file(googleSans600),
    "/fonts/google-sans-700.woff2": Bun.file(googleSans700),
  },
});
await import("./main.ts");
