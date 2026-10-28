// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - standalone fork asset verification.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import sharp from "sharp";
import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "../lib/brand-assets.ts";
import { readPngDimensions, WINDOWS_ICON_SIZES } from "../lib/icon-export.ts";

const root = new URL("../../", import.meta.url);
const files = new Set([
  ...Object.values(BRAND_ASSET_PATHS).filter((path) => /\.(png|ico)$/.test(path)),
  ...DEVELOPMENT_PUBLIC_ICON_OVERRIDES.map((override) => override.targetRelativePath),
  ...[
    "android-icon-foreground.png",
    "android-icon-background-dev.png",
    "android-icon-background-nightly.png",
    "android-splash-icon-dev.png",
    "android-splash-icon-nightly.png",
    "android-splash-icon-prod.png",
    "android-icon-mark.png",
    "android-notification-icon.png",
  ].map((name) => `apps/mobile/assets/${name}`),
  ...["favicon.ico", "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png"].map(
    (name) => `apps/marketing/public/${name}`,
  ),
  "apps/marketing/src/assets/icon.webp",
  "apps/marketing/src/assets/icon-nightly.webp",
]);
const manifest = [];
for (const path of files) {
  const contents = await NodeFSP.readFile(new URL(path, root));
  if (path.endsWith(".ico")) {
    if (
      contents.readUInt32LE(0) !== 65536 ||
      contents.readUInt16LE(4) !== WINDOWS_ICON_SIZES.length
    ) {
      throw new Error(`Invalid ICO header: ${path}`);
    }
    for (const [index, size] of WINDOWS_ICON_SIZES.entries()) {
      const offset = 6 + index * 16;
      const bytes = contents.readUInt32LE(offset + 8);
      const start = contents.readUInt32LE(offset + 12);
      const dimensions = readPngDimensions(contents.subarray(start, start + bytes));
      if (dimensions.width !== size || dimensions.height !== size) {
        throw new Error(`Missing ${size}px ICO rendition: ${path}`);
      }
    }
  } else {
    const expected = path.includes("notification")
      ? 96
      : path.includes("android-splash")
        ? 1152
        : path.includes("android-")
          ? 432
          : path.includes("16x16")
            ? 16
            : path.includes("32x32")
              ? 32
              : path.includes("apple-touch")
                ? 180
                : 1024;
    const image = sharp(contents);
    const metadata = await image.metadata();
    if (metadata.width !== expected || metadata.height !== expected) {
      throw new Error(`Wrong dimensions: ${path}: ${metadata.width}x${metadata.height}`);
    }
    if (path.includes("-macos-")) {
      const pixels = await image.ensureAlpha().raw().toBuffer();
      for (let coordinate = 0; coordinate < 1024; coordinate++) {
        const expectedOpaque = coordinate >= 100 && coordinate <= 923;
        for (const index of [512 * 1024 + coordinate, coordinate * 1024 + 512]) {
          if ((pixels[index * 4 + 3] === 255) !== expectedOpaque) {
            throw new Error(`Wrong native macOS safe area: ${path}`);
          }
        }
      }
    }
  }
  manifest.push({ path, bytes: contents.length, sha256: NodeCrypto.hash("sha256", contents) });
}
const text = await NodeFSP.readFile(
  new URL("assets/prod/app-icon.icon/Assets/text.svg", root),
  "utf8",
);
const outline = text.match(/\sd="([^"]+)"/)?.[1];
if (!outline) throw new Error("Missing source wordmark");
for (const path of [
  "assets/dev/app-icon.icon/Assets/text.svg",
  "assets/nightly/app-icon.icon/Assets/text.svg",
  "assets/prod/logo.svg",
  "apps/mobile/assets/widget/T3Mark.svg",
  "apps/web/src/components/T3Wordmark.tsx",
  "apps/mobile/src/components/T3Wordmark.tsx",
  "apps/marketing/src/layouts/Layout.astro",
]) {
  if (!(await NodeFSP.readFile(new URL(path, root), "utf8")).includes(outline)) {
    throw new Error(`Wordmark differs from canonical Tx outlines: ${path}`);
  }
}
for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
  const source = await NodeFSP.readFile(new URL(override.sourceRelativePath, root));
  const target = await NodeFSP.readFile(new URL(override.targetRelativePath, root));
  if (!source.equals(target)) throw new Error(`Stale web copy: ${override.targetRelativePath}`);
}
if (process.argv[2])
  await NodeFSP.writeFile(process.argv[2], `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Verified ${manifest.length} icon files, ICO sizes, macOS safe areas, and shared Tx outlines.`,
);
