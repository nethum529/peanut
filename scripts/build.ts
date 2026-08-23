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
await Bun.write(`${root}packages/web/dist/app.js.txt`, await web.outputs[0]!.text());
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
process.exit(await compile.exited);
