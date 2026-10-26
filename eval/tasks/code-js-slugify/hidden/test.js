const assert = require("assert");
const { slugify } = require(process.env.SANDBOX + "/slugify.js");
assert.strictEqual(slugify("Hello,  World!"), "hello-world");
assert.strictEqual(slugify("Café Déjà Vu"), "cafe-deja-vu");
assert.strictEqual(slugify("  --Already-Slugged--  "), "already-slugged");
assert.strictEqual(slugify("v2.0 Release_Notes"), "v2-0-release-notes");
assert.strictEqual(slugify("!!!"), "");
console.log("ok");
