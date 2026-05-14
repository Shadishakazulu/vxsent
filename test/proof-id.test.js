const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

function generateProofId() {
  const year = new Date().getFullYear();
  const bytes = crypto.randomBytes(12).toString("hex").toUpperCase();
  return `SENT-${year}-${bytes.substring(0, 6)}-${bytes.substring(6, 10)}-${bytes.substring(10, 14)}-${bytes.substring(14, 18)}`;
}

test("generateProofId returns expected SENT format", () => {
  const id = generateProofId();
  assert.match(id, /^SENT-\d{4}-[A-F0-9]{6}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
});
