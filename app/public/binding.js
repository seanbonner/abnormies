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
