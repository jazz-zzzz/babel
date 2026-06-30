const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "../..");

const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".txt",
  ".yml",
]);

const scannedEntries = [
  ".env",
  ".github",
  "config-overrides.js",
  "public",
  "scripts",
  "src",
];

function rootFilePaths() {
  return fs
    .readdirSync(projectRoot)
    .map((name) => path.join(projectRoot, name))
    .filter((entryPath) => fs.statSync(entryPath).isFile());
}

const ignoredRelativePaths = new Set([
  path.normalize("src/config/branding.test.js"),
]);

const legacyBrandPatterns = [
  /KISS Translator/i,
  /kiss-translator/i,
  /fishjar\/kiss/i,
  /fishjar\.github\.io\/kiss/i,
  /kiss-rules/i,
  /简约翻译/,
  /簡約翻譯/,
];

function walk(entryPath) {
  if (!fs.existsSync(entryPath)) return [];

  const stat = fs.statSync(entryPath);
  if (stat.isFile()) return [entryPath];

  return fs
    .readdirSync(entryPath)
    .flatMap((name) => walk(path.join(entryPath, name)));
}

function isTextFile(filePath) {
  if (path.basename(filePath) === ".env") return true;
  return textExtensions.has(path.extname(filePath).toLowerCase());
}

describe("Babel branding", () => {
  test("does not ship legacy KISS brand references in user-facing sources", () => {
    const files = Array.from(
      new Set([
        ...rootFilePaths(),
        ...scannedEntries.flatMap((entry) =>
          walk(path.join(projectRoot, entry))
        ),
      ])
    );

    const failures = [];

    for (const filePath of files) {
      const relativePath = path.relative(projectRoot, filePath);
      const normalizedRelativePath = path.normalize(relativePath);
      if (ignoredRelativePaths.has(normalizedRelativePath)) continue;

      for (const pattern of legacyBrandPatterns) {
        if (pattern.test(relativePath)) {
          failures.push(`${relativePath}: filename matches ${pattern}`);
        }
      }

      if (!isTextFile(filePath)) continue;

      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        for (const pattern of legacyBrandPatterns) {
          if (pattern.test(line)) {
            failures.push(
              `${relativePath}:${index + 1}: content matches ${pattern}`
            );
          }
        }
      });
    }

    expect(failures).toEqual([]);
  });
});
