// The compile entry for bun build --compile. The web assets are
// pre-built by scripts/build.ts and embedded here as text, so the
// binary never reads web sources from disk. Font imports use Bun's
// file loader so they live in the compiled executable too. The dev
// tree does not use this file; bun runs main.ts directly.

import appJs from "../../web/dist/app.js.txt" with { type: "text" };
import indexHtml from "../../web/dist/index.html.txt" with { type: "text" };
import googleSans from "../../web/public/fonts/google-sans.woff2" with { type: "file" };
import googleSansLatinExt from "../../web/public/fonts/google-sans-latin-ext.woff2" with {
  type: "file",
};
import googleSansItalic from "../../web/public/fonts/google-sans-italic.woff2" with {
  type: "file",
};
import googleSansItalicLatinExt from "../../web/public/fonts/google-sans-italic-latin-ext.woff2" with {
  type: "file",
};
import { setEmbeddedAssets } from "../../server/src/http.ts";

setEmbeddedAssets({
  indexHtml,
  appJs,
  fonts: {
    "/fonts/google-sans.woff2": Bun.file(googleSans),
    "/fonts/google-sans-latin-ext.woff2": Bun.file(googleSansLatinExt),
    "/fonts/google-sans-italic.woff2": Bun.file(googleSansItalic),
    "/fonts/google-sans-italic-latin-ext.woff2": Bun.file(googleSansItalicLatinExt),
  },
});
await import("./main.ts");
