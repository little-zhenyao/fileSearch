import { cp, mkdir } from "node:fs/promises";
for (const folder of ["cmaps", "standard_fonts", "wasm"]) {
  const dest = new URL(`../public/pdf-assets/${folder}/`, import.meta.url);
  await mkdir(dest, { recursive: true });
  await cp(
    new URL(`../node_modules/pdfjs-dist/${folder}/`, import.meta.url),
    dest,
    { recursive: true },
  );
}
