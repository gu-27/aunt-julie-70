/**
 * Aunt Julie 70 — Cloudflare Worker
 *
 * Proxies GitHub API writes so the token never touches the browser.
 * Reads happen directly from the client (public repo, no auth needed).
 *
 * Secret required in Cloudflare dashboard:
 *   GITHUB_TOKEN  — fine-grained PAT with Contents: Read & Write on gu-27/aunt-julie-70
 */

const OWNER    = 'gu-27';
const REPO     = 'aunt-julie-70';
const BRANCH   = 'main';
const DATA_PATH = 'docs/memories.json';
const GH_API   = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${DATA_PATH}`;

// Allowed origins — tighten if needed
const ALLOWED_ORIGIN = '*';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return cors('', 204);
    }

    if (request.method !== 'POST') {
      return cors(JSON.stringify({ error: 'POST only' }), 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return cors(JSON.stringify({ error: 'Invalid JSON' }), 400);
    }

    const { action, entry, id, updates } = body;
    if (!['add', 'edit', 'delete'].includes(action)) {
      return cors(JSON.stringify({ error: 'Unknown action' }), 400);
    }

    const token = env.GITHUB_TOKEN;
    if (!token) {
      return cors(JSON.stringify({ error: 'Worker misconfigured: no GITHUB_TOKEN' }), 500);
    }

    try {
      // 1. Read current file + SHA
      const getRes = await fetch(GH_API, {
        headers: {
          Authorization: `token ${token}`,
          'User-Agent':  'aunt-julie-worker'
        }
      });
      if (!getRes.ok) {
        return cors(JSON.stringify({ error: `GitHub read failed: ${getRes.status}` }), 502);
      }
      const fileData = await getRes.json();
      const sha = fileData.sha;
      const memories = JSON.parse(decodeBase64UTF8(fileData.content.replace(/\n/g, '')));

      // 2. Apply transform
      let updated;
      if (action === 'add') {
        updated = [...memories, entry];
      } else if (action === 'edit') {
        if (!id || !updates) return cors(JSON.stringify({ error: 'id and updates required' }), 400);
        updated = memories.map(m => m.id === id ? { ...m, ...updates } : m);
      } else if (action === 'delete') {
        if (!id) return cors(JSON.stringify({ error: 'id required' }), 400);
        updated = memories.filter(m => m.id !== id);
      }

      // 3. Write back
      const content = encodeBase64UTF8(JSON.stringify(updated, null, 2));
      const putRes = await fetch(GH_API, {
        method: 'PUT',
        headers: {
          Authorization:  `token ${token}`,
          'Content-Type': 'application/json',
          'User-Agent':   'aunt-julie-worker'
        },
        body: JSON.stringify({
          message: 'Update memories.json',
          content,
          sha,
          branch: BRANCH
        })
      });

      if (!putRes.ok) {
        const err = await putRes.json().catch(() => ({}));
        return cors(JSON.stringify({ error: err.message || `GitHub write failed: ${putRes.status}` }), 502);
      }

      const result = await putRes.json();
      return cors(JSON.stringify({ ok: true, sha: result.content.sha }));

    } catch (e) {
      return cors(JSON.stringify({ error: e.message }), 500);
    }
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function cors(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function encodeBase64UTF8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

function decodeBase64UTF8(b64) {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
