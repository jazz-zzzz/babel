// Generate Babel extension icons
const sharp = require("sharp");
const path = require("path");

const SIZES = [16, 32, 48, 128, 192];
const OUT_DIR = path.join(__dirname, "..", "public", "images");

// Keep the original _active variants (they're the same for now)
// We'll generate both normal and active for each size

async function createIcon(size, active = false) {
  const name = `logo${size}${active ? "_active" : ""}.png`;
  const outPath = path.join(OUT_DIR, name);

  // Babel icon: rounded square with gradient, letter "B"
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${active ? "#6366F1" : "#4F46E5"}"/>
        <stop offset="100%" stop-color="${active ? "#8B5CF6" : "#7C3AED"}"/>
      </linearGradient>
    </defs>
    <rect width="128" height="128" rx="28" fill="url(#bg)"/>
    <text x="64" y="88" font-family="Arial, Helvetica, sans-serif" font-size="74" font-weight="bold" fill="white" text-anchor="middle">B</text>
  </svg>`;

  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath);

  console.log(`  ${name} (${size}x${size})`);
}

async function createFavicon() {
  const outPath = path.join(OUT_DIR, "..", "favicon.ico");
  // Just use the 32px PNG as favicon base
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 128 128">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#4F46E5"/>
        <stop offset="100%" stop-color="#7C3AED"/>
      </linearGradient>
    </defs>
    <rect width="128" height="128" rx="28" fill="url(#bg)"/>
    <text x="64" y="88" font-family="Arial, Helvetica, sans-serif" font-size="74" font-weight="bold" fill="white" text-anchor="middle">B</text>
  </svg>`;

  await sharp(Buffer.from(svg)).resize(32, 32).png().toFile(outPath);

  console.log(`  favicon.ico (32x32)`);
}

async function main() {
  console.log("Generating Babel icons...");

  // Generate normal icons at all sizes
  for (const size of SIZES) {
    await createIcon(size, false);
  }

  // Generate active icons at all sizes (lighter gradient)
  for (const size of SIZES) {
    await createIcon(size, true);
  }

  // Generate favicon
  await createFavicon();

  console.log("Done!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
