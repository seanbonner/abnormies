// Shared Normies agent-binding lookup.
//
// Resolves a seed Normie's bound agent from the Normies API. Used by the detail
// page (abnormie.js) and the holdings page (clouds.js) staleness diff, so it
// lives in one place rather than being duplicated per page.
//
// api.normies.art shape (as of 2026-06-03):
//   { "binding": { "agentId": "32512", "tokenId": "994", ... } }
// agentId is a NESTED, CAMEL-CASE, STRING field. Earlier readers looked for a
// top-level snake-case `agent_id`, which silently always evaluated to null,
// making the awakening check never fire even for seeds that ARE bound upstream.
// Normalised return shape: { agentId: BigInt } or null. Callers use only
// `binding.agentId` from this point forward.
export async function fetchBinding(seedId) {
  try {
    const res = await fetch(`https://api.normies.art/agents/binding/${seedId}`);
    if (!res.ok) return null;
    const j = await res.json();
    const raw = j && typeof j === "object" ? j.binding?.agentId : null;
    if (raw == null || raw === "") return null;
    try {
      return { agentId: BigInt(raw) };
    } catch {
      return null;
    }
  } catch {
    return null; // network/CORS failure -> treat as no binding
  }
}

// Total customizations applied to a seed Normie. The Normies API exposes the
// full transform version history; the count is the array length. Returns the
// count, or null on any failure so callers fall back to the on-chain boolean.
export async function fetchCustomizationCount(seedId) {
  try {
    const res = await fetch(`https://api.normies.art/history/normie/${seedId}/versions`);
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j) ? j.length : null;
  } catch {
    return null;
  }
}

// Burn-history image source for a seed Normie. Post-burn the live tokenURI
// reverts, so this endpoint is the only image source. Pure URL builder (the
// caller uses it as an <img src>); the <img> error handler covers failures.
export function burnedSeedImageUrl(tokenId) {
  return `https://api.normies.art/history/burned/${tokenId}/image.svg`;
}

// Live indexed customization state for a seed Normie's canvas. Returns the
// `customized` boolean, or null on any failure so callers fall back to the
// NormiesCanvasStorage.isTransformed RPC read.
export async function fetchCanvasCustomized(seedId) {
  try {
    const res = await fetch(`https://api.normies.art/normie/${seedId}/canvas/info`);
    if (!res.ok) return null;
    const j = await res.json();
    return j && typeof j === "object" && typeof j.customized === "boolean" ? j.customized : null;
  } catch {
    return null;
  }
}
