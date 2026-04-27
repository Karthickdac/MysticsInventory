// Post-codegen patch for orval output.
//
// When an operation has both path AND query parameters, orval's `zod`
// generator emits a `XxxParams` zod schema in api.ts (for path params)
// AND a `XxxParams` TS type in generated/types/ (for query params),
// causing a TS2308 collision when both are re-exported. Drop the
// conflicting type re-exports from generated/types/index.ts so the
// zod schema (in api.ts) wins. Consumers that need the query type can
// use the corresponding `XxxQueryParams` zod schema's inferred type.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, "..", "..", "..");
const apiZodApi = resolve(root, "lib", "api-zod", "src", "generated", "api.ts");
const apiZodTypesIndex = resolve(
  root,
  "lib",
  "api-zod",
  "src",
  "generated",
  "types",
  "index.ts",
);

if (!existsSync(apiZodApi) || !existsSync(apiZodTypesIndex)) {
  console.error("[post-codegen] expected generated files not found, skipping");
  process.exit(0);
}

const api = readFileSync(apiZodApi, "utf8");
// Names exported as zod schemas in api.ts
const apiExports = new Set(
  Array.from(api.matchAll(/^export const (\w+) = /gm)).map((m) => m[1]),
);

let types = readFileSync(apiZodTypesIndex, "utf8");
const lines = types.split("\n");
const kept = [];
const dropped = [];
for (const line of lines) {
  // export * from "./fooBar";
  const m = line.match(/^export \* from "\.\/([a-zA-Z0-9_]+)";$/);
  if (m) {
    // The default exported type name is PascalCase of the filename.
    const file = m[1];
    const typeName = file.charAt(0).toUpperCase() + file.slice(1);
    if (apiExports.has(typeName)) {
      dropped.push(typeName);
      continue;
    }
  }
  kept.push(line);
}

if (dropped.length > 0) {
  writeFileSync(apiZodTypesIndex, kept.join("\n"));
  console.log(
    `[post-codegen] dropped ${dropped.length} conflicting type re-export(s) from api-zod types/index.ts: ${dropped.join(", ")}`,
  );
} else {
  console.log("[post-codegen] no conflicts found");
}
