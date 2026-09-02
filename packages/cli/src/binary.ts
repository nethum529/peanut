// The compile entry for bun build --compile. The web assets are
// pre-built by scripts/build.ts and embedded here as text, so the
// binary never reads web sources from disk. Font imports use Bun's
// file loader so they live in the compiled executable too. The dev
// tree does not use this file; bun runs main.ts directly.

import appJs from "../../web/dist/app.js.txt" with { type: "text" };
import indexHtml from "../../web/dist/index.html.txt" with { type: "text" };
import overlayJs from "../../web/dist/overlay.js.txt" with { type: "text" };
import overlayCss from "../../web/public/overlay.css" with { type: "text" };
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
import iconSvg from "../../web/public/icon.svg" with { type: "file" };
import faviconIco from "../../web/public/favicon.ico" with { type: "file" };
import appleTouchIcon from "../../web/public/apple-touch-icon.png" with { type: "file" };
import icon192 from "../../web/public/icon-192.png" with { type: "file" };
import icon512 from "../../web/public/icon-512.png" with { type: "file" };
import iconMask from "../../web/public/icon-mask.png" with { type: "file" };
import manifest from "../../web/public/manifest.webmanifest" with { type: "file" };
import { setEmbeddedAssets } from "../../server/src/http.ts";

setEmbeddedAssets({
  indexHtml,
  appJs,
  overlayJs,
  overlayCss,
  fonts: {
    "/fonts/google-sans.woff2": Bun.file(googleSans),
    "/fonts/google-sans-latin-ext.woff2": Bun.file(googleSansLatinExt),
    "/fonts/google-sans-italic.woff2": Bun.file(googleSansItalic),
    "/fonts/google-sans-italic-latin-ext.woff2": Bun.file(googleSansItalicLatinExt),
  },
  icons: {
    "/icon.svg": Bun.file(iconSvg),
    "/favicon.ico": Bun.file(faviconIco),
    "/apple-touch-icon.png": Bun.file(appleTouchIcon),
    "/icon-192.png": Bun.file(icon192),
    "/icon-512.png": Bun.file(icon512),
    "/icon-mask.png": Bun.file(iconMask),
    "/manifest.webmanifest": Bun.file(manifest),
  },
});
await import("./main.ts");
