import { fileURLToPath } from "node:url";

const shim = new URL("./react-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "react" || specifier === "react/jsx-runtime") {
    return { url: shim, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function loaderFile() {
  return fileURLToPath(import.meta.url);
}
