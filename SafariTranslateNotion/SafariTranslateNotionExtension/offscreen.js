/**
 * Offscreen document: proxies fetch requests from the service worker.
 *
 * Fetches are made WITHOUT auth/content-type headers in JavaScript so that
 * Chrome treats them as "simple" requests (no CORS preflight). Auth headers
 * (Authorization, Content-Type, Notion-Version) are injected at the network
 * layer by declarativeNetRequest dynamic rules (updateChromeAuthRules), and
 * Access-Control-Allow-Origin is added to responses by static cors-rules.json.
 *
 * This works because requests from extension HTML pages (like this offscreen
 * document) are classified as "xmlhttprequest" in declarativeNetRequest,
 * unlike service worker fetches which may not be intercepted by DNR rules.
 */
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type !== "__offscreenFetch__") return false;
  // Intentionally NO headers — DNR injects them at the network layer.
  fetch(message.url, {
    method: message.method || "GET",
    body: message.body || undefined,
  })
    .then(function (res) {
      var status = res.status;
      return res.text().then(function (text) {
        sendResponse({ status: status, body: text });
      });
    })
    .catch(function (err) {
      sendResponse({ error: err.message || "Fetch failed" });
    });
  return true; // keep message channel open for async response
});
