import { URL } from "node:url";
import { readOnlyRequestAllowed } from "./read-only-policy.mjs";
/** Only visible-UI requests to the scoped recipient. No accounts/login, downloads or other forms. */
export function formRequestAllowed({ url, method, navigation, postData = "", formUrl, mayFill, workbenchOrigin }) {
  try {
    const request = new URL(url), destination = new URL(formUrl);
    if (request.protocol !== "https:" || request.username || request.password || request.port) return false;
    if (request.origin === workbenchOrigin) return ["GET", "HEAD"].includes(method) && (!navigation || request.pathname === "/workbench");
    if (["www.gstatic.com", "ssl.gstatic.com", "fonts.gstatic.com", "fonts.googleapis.com"].includes(request.hostname)) return !navigation && ["GET", "HEAD"].includes(method);
    if (request.hostname !== "docs.google.com" || destination.hostname !== "docs.google.com") return false;
    const base = destination.pathname.replace(/\/viewform\/?$/, "");
    if (![`${base}/viewform`, `${base}/formResponse`].includes(request.pathname)) return false;
    if (!mayFill) return readOnlyRequestAllowed({ url, method, navigation, postData });
    // This merely permits the browser's UI transport; the runner never constructs HTTP responses.
    return ["GET", "HEAD"].includes(method) || method === "POST" && navigation && request.pathname === `${base}/formResponse`;
  } catch { return false; }
}
