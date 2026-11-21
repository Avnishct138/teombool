/**
 * Proposals — the "preview → user approval" mechanism.
 *
 * A tool may propose a change (new weights, new activation, new architecture).
 * The proposal is stored **server side** in KV with a short TTL and returned to
 * the browser as a read-only preview. The browser can never write the model
 * configuration directly: it must ask `/approve`, and only then does the server
 * hand back the authoritative payload, which the client applies locally.
 *
 * Proposals are single-use — approving deletes them, so a leaked id cannot be
 * replayed.
 */

export const PROPOSAL_TTL_SECONDS = 900;
const KEY_PREFIX = 'agni:proposal:';

function randomHex(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isValidProposalId(id) {
  return typeof id === 'string' && /^[a-f0-9]{16}$/.test(id);
}

/**
 * @param {object} env
 * @param {object} proposal  { kind, title, summary, diff, payload }
 * @returns {Promise<object|null>} the stored proposal (with id/expiresAt) or null
 */
export async function storeProposal(env, proposal) {
  const kv = env.TMB_SHARES;
  if (!kv || typeof kv.put !== 'function') return null;
  const id = randomHex(8);
  const now = Date.now();
  const record = {
    id,
    kind: String(proposal.kind || 'change').slice(0, 40),
    title: String(proposal.title || 'बदलाव').slice(0, 200),
    summary: String(proposal.summary || '').slice(0, 1000),
    diff: Array.isArray(proposal.diff) ? proposal.diff.slice(0, 100) : [],
    payload: proposal.payload && typeof proposal.payload === 'object' ? proposal.payload : {},
    createdAt: now,
    expiresAt: now + PROPOSAL_TTL_SECONDS * 1000,
  };
  await kv.put(`${KEY_PREFIX}${id}`, JSON.stringify(record), { expirationTtl: PROPOSAL_TTL_SECONDS });
  return record;
}

/** Fetch a proposal without consuming it. */
export async function peekProposal(env, id) {
  if (!isValidProposalId(id)) return null;
  const kv = env.TMB_SHARES;
  if (!kv || typeof kv.get !== 'function') return null;
  const raw = await kv.get(`${KEY_PREFIX}${id}`, 'json');
  if (!raw) return null;
  if (raw.expiresAt && raw.expiresAt < Date.now()) {
    await kv.delete(`${KEY_PREFIX}${id}`).catch(() => {});
    return null;
  }
  return raw;
}

/** Consume a proposal (single use). Returns the record or null. */
export async function consumeProposal(env, id) {
  const record = await peekProposal(env, id);
  if (!record) return null;
  const kv = env.TMB_SHARES;
  await kv.delete(`${KEY_PREFIX}${id}`).catch(() => {});
  return record;
}
