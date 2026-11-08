/**
 * Generates the Kit client for the AESDR program from its Anchor IDL.
 *
 * Solana's recommended JS stack is @solana/kit plus generated program clients;
 * hand-maintaining instruction encoders is exactly the drift Codama exists to
 * prevent. This script is the single source of truth for `pkgs/client/src/generated`.
 *
 * Run after `anchor build`:  npm run codegen
 */
import { createFromRoot } from "codama";
import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const idlPath = resolve(root, "target/idl/aesdr.json");

if (!existsSync(idlPath)) {
  console.error("target/idl/aesdr.json not found - run `anchor build` first");
  process.exit(1);
}

const idl = JSON.parse(readFileSync(idlPath, "utf8"));
if (!idl.address) {
  console.error(
    "IDL has no program address - run `anchor keys sync` then `anchor build`"
  );
  process.exit(1);
}

const codama = createFromRoot(rootNodeFromAnchor(idl));

// The renderer appends `src/generated` to whatever folder it is given, so this
// points at the package root, not the output directory.
const packageDir = resolve(root, "pkgs/client");

await codama.accept(
  renderVisitor(packageDir, {
    // The package.json in pkgs/client is authored by hand; let Codama only own
    // the generated tree.
    syncPackageJson: false,
    formatCode: true,
  })
);

console.log(`codama: generated Kit client for ${idl.address}`);
console.log(`codama: -> pkgs/client/src/generated`);
