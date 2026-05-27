// Offline test for the detail page's tokenURI parsing.
//
// Imports the exact pure helpers used by the browser (abnormie.js skips its
// DOM bootstrap when `window` is undefined) and exercises them against mock
// metadata shaped like what the Abnormies contract returns from tokenURI:
// a base64 data: URI wrapping JSON whose `image` is itself an SVG data: URI.
//
// Once a revealed Abnormie exists on Sepolia, point the same helpers at the
// live tokenURI output to confirm the real shape matches. Run: npm run test-parse
//
// Exits non-zero on any failed assertion.

import { decodeDataUri, parseTokenURI, extractSvgMarkup, shortAddr } from "../public/abnormie.js";

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#e3e5e4"/></svg>';
const META = {
  name: "Abnormie #234",
  description: "A fully on-chain Abnormie.",
  image: `data:image/svg+xml;base64,${b64(SVG)}`,
  attributes: [
    { trait_type: "State", value: "Active" },
    { trait_type: "Source Life", value: "Living" },
    { trait_type: "Cirrus", value: 7 },
    { trait_type: "Inverted", value: "No" }
  ]
};

// --- base64 metadata (the common Solidity pattern) -------------------------
console.log("base64 metadata:");
{
  const uri = `data:application/json;base64,${b64(JSON.stringify(META))}`;
  const meta = parseTokenURI(uri);
  check("name parsed", meta.name === "Abnormie #234");
  check("attributes length", Array.isArray(meta.attributes) && meta.attributes.length === 4);
  check("trait value preserved (number)", meta.attributes[2].value === 7);
  const svg = extractSvgMarkup(meta.image);
  check("svg extracted", svg.startsWith("<svg") && svg.includes("</svg>"));
  check("svg byte-identical", svg === SVG);
}

// --- ;utf8, metadata (raw JSON, no percent-encoding) -----------------------
console.log(";utf8, metadata:");
{
  const uri = `data:application/json;utf8,${JSON.stringify(META)}`;
  const meta = parseTokenURI(uri);
  check("name parsed", meta.name === "Abnormie #234");
  check("svg extracted", extractSvgMarkup(meta.image).startsWith("<svg"));
}

// --- mime + decode primitives ----------------------------------------------
console.log("decodeDataUri primitives:");
{
  const { mime, body } = decodeDataUri(`data:application/json;base64,${b64('{"a":1}')}`);
  check("mime parsed", mime === "application/json");
  check("body decoded", body === '{"a":1}');
  let threw = false;
  try {
    decodeDataUri("https://example.com/not-a-data-uri");
  } catch {
    threw = true;
  }
  check("non-data URI throws", threw);
}

// --- shortAddr -------------------------------------------------------------
console.log("shortAddr:");
{
  check("shortens", shortAddr("0x1234567890abcdef1234567890abcdef12345678") === "0x1234…5678");
  check("null -> dash", shortAddr(null) === "—");
}

console.log("");
if (failures > 0) {
  console.error(`${failures} assertion(s) failed.`);
  process.exit(1);
}
console.log("All parsing assertions passed.");
