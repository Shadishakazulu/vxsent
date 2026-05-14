const fs = require("fs");

const required = [
  "netlify.toml",
  "package.json",
  "supabase-schema-final.sql",
  ".env.example",
  "README.md"
];

let failed = false;

for (const file of required) {
  if (!fs.existsSync(file)) {
    console.error(`Missing required file: ${file}`);
    failed = true;
  }
}

const netlify = fs.existsSync("netlify.toml") ? fs.readFileSync("netlify.toml", "utf8") : "";
if (netlify.includes("SECRETS_SCAN_OMIT_PATHS")) {
  console.error("Remove SECRETS_SCAN_OMIT_PATHS. Do not bypass secret scanning.");
  failed = true;
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (!pkg.scripts || !pkg.scripts.test || pkg.scripts.test.includes("Error: no test specified")) {
  console.error("package.json must define a real test script.");
  failed = true;
}

if (failed) process.exit(1);
console.log("Config validation passed.");
