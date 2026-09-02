// Embedded text assets carry a txt suffix so the bun html
// loader does not claim them and the type stays string.
declare module "*.txt" {
  const text: string;
  export default text;
}

declare module "*.css" {
  const text: string;
  export default text;
}

declare module "*.woff2" {
  const path: string;
  export default path;
}

declare module "*.svg" {
  const path: string;
  export default path;
}

declare module "*.ico" {
  const path: string;
  export default path;
}

declare module "*.png" {
  const path: string;
  export default path;
}

declare module "*.webmanifest" {
  const path: string;
  export default path;
}
