'use strict';

// Pulls generated image URLs out of a ChatGPT conversation's DOM. Port of
// internal/capture/filter.go.
//
// SECURITY BOUNDARY, not a convenience filter: isGeneratedImageUrl() guards
// an in-page fetch(url, {credentials: 'include'}) that carries the user's
// ChatGPT session cookie. The URLs it is asked to judge come straight from
// page DOM, which is reachable by prompt injection (a malicious image alt
// text or a compromised/adversarial page could hand back any string). Get
// this wrong and it becomes a same-origin-cookie exfiltration primitive.

// The same-origin, cookie-authenticated endpoint ChatGPT serves generated
// images from. Verified by spike, 2026-09-01.
const GENERATED_PATH = '/backend-api/estuary/content';

/**
 * Reports whether a hostname is an allowed OpenAI domain.
 *
 * Compares `url.hostname` (not `url.host`, which also carries the port) and
 * lowercases first, since hostnames are case-insensitive but the allowlist
 * literals below are lowercase.
 */
function isOpenAIHost(hostname) {
  if (!hostname) return false;
  hostname = hostname.toLowerCase();
  // Exact matches.
  if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') return true;
  // Subdomain matches.
  if (hostname.endsWith('.chatgpt.com') || hostname.endsWith('.oaiusercontent.com')) return true;
  return false;
}

/**
 * Reports whether a URL is a generated image rather than ChatGPT's own UI
 * furniture. Enforces an OpenAI host allowlist and requires the `id` query
 * parameter to have the file_ prefix. Matches on path, not size: a size
 * heuristic was found by the spike to capture sprite sheets and avatars too.
 */
function isGeneratedImageUrl(u) {
  if (!u) return false;
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return false;
  }
  if (parsed.pathname !== GENERATED_PATH) return false;
  const id = parsed.searchParams.get('id') || '';
  if (!id.startsWith('file_')) return false;
  return isOpenAIHost(parsed.hostname);
}

/**
 * Returns the file_... id, used to tell distinct images apart when
 * generating a set. Returns '' if the URL is not a generated image.
 *
 * Must agree with isGeneratedImageUrl on every input: this function returns
 * a non-empty id if and only if isGeneratedImageUrl(u) is true.
 */
function fileIdFromUrl(u) {
  if (!isGeneratedImageUrl(u)) return '';
  const parsed = new URL(u);
  const id = parsed.searchParams.get('id') || '';
  if (!id.startsWith('file_')) return '';
  return id;
}

module.exports = { isGeneratedImageUrl, fileIdFromUrl };
