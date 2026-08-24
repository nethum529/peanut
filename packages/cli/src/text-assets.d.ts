// Embedded text assets carry a txt suffix so the bun html
// loader does not claim them and the type stays string.
declare module "*.txt" {
  const text: string;
  export default text;
}

declare module "*.woff2" {
  const path: string;
  export default path;
}
