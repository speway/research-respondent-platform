/** Network guard for source-free audits; decoded prefill/edit/answer parameters are refused. */
import { URL, URLSearchParams } from "node:url";
const answerKey = (key) => /^entry[._]|^(edit2|draftResponse|emailAddress|email)$/i.test(key);
export function isReadOnlyFormUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.hostname === "forms.gle" && /^\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) ||
        url.hostname === "docs.google.com" && /^\/forms\/d\/(?:e\/)?[a-zA-Z0-9_-]+\/(?:viewform|formResponse)$/.test(url.pathname)) &&
      ![...url.searchParams.keys()].some((key) => answerKey(key) || key.toLowerCase() === "partialresponse");
  } catch { return false; }
}
export function readOnlyRequestAllowed({ url, method, navigation, postData = "" }) {
  try {
    const parsed = new URL(url);
    if ([...parsed.searchParams.keys()].some((key) => answerKey(key) || key.toLowerCase() === "partialresponse")) return false;
    if (["GET", "HEAD"].includes(method)) return !navigation || isReadOnlyFormUrl(url);
    if (method !== "POST" || !navigation || !isReadOnlyFormUrl(url) || parsed.hostname !== "docs.google.com" || !parsed.pathname.endsWith("/formResponse") || postData.length > 16384) return false;
    const body = new URLSearchParams(postData);
    for (const [key, value] of body) {
      if (answerKey(key) || key.toLowerCase() === "submit") return false;
      if (key.toLowerCase() === "partialresponse") {
        const partial = JSON.parse(value);
        if (!Array.isArray(partial) || partial.length !== 3 ||
          !(partial[0] === null || Array.isArray(partial[0]) && !partial[0].length) || partial[1] !== null ||
          !(typeof partial[2] === "number" && Number.isFinite(partial[2]) || typeof partial[2] === "string" && /^-?\d{1,30}$/.test(partial[2]))) return false;
      }
    }
    return true;
  } catch { return false; }
}
