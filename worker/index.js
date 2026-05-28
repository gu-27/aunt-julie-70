/**
 * Aunt Julie 70 — Cloudflare Worker
 *
 * Handles two responsibilities:
 *   1. Image uploads → Cloudflare R2 (returns public URL)
 *   2. Memory writes → GitHub API (add / edit / delete)
 *
 * Reads happen directly from the client via raw.githubusercontent.com.
 *
 * Bindings required (set in Cloudflare dashboard → Worker → Settings):
 *   Secret:      GITHUB_TOKEN     fine-grained PAT, Contents R/W on gu-27/aunt-julie-70
 *   Secret:      R2_PUBLIC_URL    public bucket URL, e.g. https://pub-xxxx.r2.dev
 *   R2 Bucket:   MEMORIES_BUCKET  bound to your aunt-julie-memories bucket
 */

const OWNER     = 'gu-27';
const REPO      = 'aunt-julie-70';
const BRANCH    = 'main';
const DATA_PATH = 'docs/memories.json';
const GH_API    = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${DATA_PATH}`;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors('', 204);
    if (request.method !== 'POST') return cors(JSON.stringify({ error: 'POST only' }), 405);

    let body;
    try { body = await request.json(); }
    catch { return cors(JSON.stringify({ error: 'Invalid JSON' }), 400); }

    const { action } = body;

    // ── Image upload ──────────────────────────────────────────────────────────
    if (action === 'upload-image') {
      if (!env.MEMORIES_BUCKET) {
        return cors(JSON.stringify({ error: 'R2 bucket not bound — check Worker settings' }), 500);
      }
      if (!env.R2_PUBLIC_URL) {
        return cors(JSON.stringify({ error: 'R2_PUBLIC_URL secret not set' }), 500);
      }

      const { filename, contentType, data } = body;
      if (!filename || !data) {
        return cors(JSON.stringify({ error: 'filename and data required' }), 400);
      }

      // Decode base64 image data
      const binaryStr = atob(data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      await env.MEMORIES_BUCKET.put(filename, bytes, {
        httpMetadata: { contentType: contentType || 'image/jpeg' }
      });

      const baseUrl = env.R2_PUBLIC_URL.replace(/\/$/, '');
      return cors(JSON.stringify({ ok: true, url: `${baseUrl}/${filename}` }));
    }

    // ── Memory writes ─────────────────────────────────────────────────────────
    if (!['add', 'edit', 'delete'].includes(action)) {
      return cors(JSON.stringify({ error: 'Unknown action' }), 400);
    }

    const token = env.GITHUB_TOKEN;
    if (!token) {
      return cors(JSON.stringify({ error: 'GITHUB_TOKEN secret not set' }), 500);
    }

    try {
      // Retry up to 3 times on 409 conflict (concurrent writes)
      for (let attempt = 0; attempt < 3; attempt++) {
        // 1a. Get file SHA via Contents API (always current)
        const metaRes = await fetch(GH_API, {
          headers: { Authorization: `token ${token}`, 'User-Agent': 'aunt-julie-worker' }
        });
        if (!metaRes.ok) {
          return cors(JSON.stringify({ error: `GitHub meta read failed: ${metaRes.status}` }), 502);
        }
        const meta = await metaRes.json();
        const sha = meta.sha;

        // 1b. Read content via Git Blobs API — always current, no size limit
        const blobRes = await fetch(
          `https://api.github.com/repos/${OWNER}/${REPO}/git/blobs/${sha}`,
          {
            headers: {
              Authorization: `token ${token}`,
              'User-Agent':  'aunt-julie-worker',
              'Accept':      'application/vnd.github.raw+json'
            }
          }
        );
        if (!blobRes.ok) {
          return cors(JSON.stringify({ error: `GitHub blob read failed: ${blobRes.status}` }), 502);
        }
        const memories = await blobRes.json();

        // 2. Apply transform
        const { entry, id, updates } = body;
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
          body: JSON.stringify({ message: 'Update memories.json', content, sha, branch: BRANCH })
        });

        // 409 = SHA conflict from concurrent write — retry with fresh SHA
        if (putRes.status === 409) continue;

        if (!putRes.ok) {
          const err = await putRes.json().catch(() => ({}));
          return cors(JSON.stringify({ error: err.message || `GitHub write failed: ${putRes.status}` }), 502);
        }

        const result = await putRes.json();
        return cors(JSON.stringify({ ok: true, sha: result.content.sha }));
      }

      return cors(JSON.stringify({ error: 'Write failed after 3 attempts — please try again' }), 502);

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
      'Access-Control-Allow-Origin':  '*',
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
