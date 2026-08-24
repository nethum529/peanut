// Builds the single peanut binary. Two steps: bundle the browser
// client into packages/web/dist, then compile the CLI with those
// assets embedded. Output: dist/peanut.

const root = new URL("..", import.meta.url).pathname;

const web = await Bun.build({
  entrypoints: [`${root}packages/web/src/app.ts`],
  target: "browser",
  minify: true,
});
if (!web.success) {
  console.error("Client bundle failed:");
  for (const message of web.logs) console.error(String(message));
  process.exit(1);
}
if (web.outputs.length !== 1) {
  console.error(`Expected one client bundle, got ${web.outputs.length}.`);
  process.exit(1);
}
await Bun.write(`${root}packages/web/dist/app.js.txt`, await web.outputs[0]!.text());

const overlay = await Bun.build({
  entrypoints: [`${root}packages/web/src/overlay.ts`],
  target: "browser",
  format: "iife",
  minify: true,
});
if (!overlay.success || overlay.outputs.length !== 1) {
  console.error("Overlay bundle failed:");
  for (const message of overlay.logs) console.error(String(message));
  process.exit(1);
}
await Bun.write(`${root}packages/web/dist/overlay.js.txt`, await overlay.outputs[0]!.text());
await Bun.write(
  `${root}packages/web/dist/index.html.txt`,
  Bun.file(`${root}packages/web/public/index.html`),
);

const compile = Bun.spawn(
  [
    "bun",
    "build",
    "--compile",
    `${root}packages/cli/src/binary.ts`,
    "--outfile",
    `${root}dist/peanut`,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
const exitCode = await compile.exited;
if (exitCode === 0) {
  await Bun.write(
    `${root}dist/NOTICE`,
    Bun.file(`${root}packages/web/public/fonts/OFL.txt`),
  );
}
process.exit(exitCode);
