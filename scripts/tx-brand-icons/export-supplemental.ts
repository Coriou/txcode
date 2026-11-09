// @effect-diagnostics nodeBuiltinImport:off - standalone fork asset generation.
// Fork-only copies and silhouettes omitted by upstream's icon exporters.
import * as NodeFSP from "node:fs/promises";
import sharp from "sharp";

const root = new URL("../../", import.meta.url);
const source = await NodeFSP.readFile(
  new URL("assets/prod/app-icon.icon/Assets/text.svg", root),
  "utf8",
);
const paths = source.match(/<path[^>]*\/>/g)?.join("");
if (!paths) throw new Error("Missing Tx wordmark paths");

// Preserve each existing silhouette's canvas, placement, and artwork width.
for (const [name, canvas, width, height, left, top] of [
  ["android-icon-mark.png", 432, 280, 169, 76, 130],
  ["android-notification-icon.png", 96, 64, 39, 16, 28],
] as const) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="15.5309 37 94.3941 56.96">${paths}</svg>`;
  const input = await sharp(Buffer.from(svg), { density: 300 })
    .resize(width, height)
    .png()
    .toBuffer();
  await sharp({ create: { width: canvas, height: canvas, channels: 4, background: "#00000000" } })
    .composite([{ input, left, top }])
    .png()
    .toFile(new URL(`apps/mobile/assets/${name}`, root).pathname);
}

for (const name of [
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
]) {
  const prefix = "assets/prod/t3-black-web-";
  const sourceName = name === "apple-touch-icon.png" ? "apple-touch-180.png" : name;
  await NodeFSP.copyFile(
    new URL(`${prefix}${sourceName}`, root),
    new URL(`apps/marketing/public/${name}`, root),
  );
}
for (const [sourcePath, destination] of [
  ["assets/prod/black-ios-1024.png", "apps/marketing/src/assets/icon.webp"],
  ["assets/nightly/nightly-ios-1024.png", "apps/marketing/src/assets/icon-nightly.webp"],
] as const) {
  await sharp(new URL(sourcePath, root).pathname)
    .webp({ quality: 90, alphaQuality: 100 })
    .toFile(new URL(destination, root).pathname);
}

// Derive PWA sizes from the existing native Tx exports when Icon Composer is unavailable.
for (const [sourcePath, prefix] of [
  ["assets/dev/blueprint-ios-1024.png", "assets/dev/blueprint-web-icon"],
  ["assets/nightly/nightly-ios-1024.png", "assets/nightly/nightly-web-icon"],
  ["assets/prod/black-ios-1024.png", "assets/prod/t3-black-web-icon"],
] as const) {
  for (const size of [192, 512]) {
    const destination = new URL(`${prefix}-${size}x${size}.png`, root);
    await sharp(new URL(sourcePath, root).pathname)
      .resize(size, size)
      .png()
      .toFile(destination.pathname);
    if (prefix.startsWith("assets/dev/")) {
      await NodeFSP.copyFile(
        destination,
        new URL(`apps/web/public/icon-${size}x${size}.png`, root),
      );
    }
  }
}
