// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page side of the web-animation frame-ready bridge (inner#1711 design §7.2, DD §4.2).
 *
 * The runner inlines this script into every source package after the HyperFrames runtime. The player's own `seek()`
 * cannot say a frame is painted, so the page answers each seek itself. Messages are taken only from
 * `window.parent`, and both directions post with target origin `*` because the sandboxed page's origin is null:
 *
 * - `breatic-bridge-ready` goes out once the runtime sets `window.__playerReady`, and again for every
 *   `breatic-hello` after that;
 * - each `breatic-seek {session, sequence, time}` calls `window.__player.renderSeek(time)`, waits for
 *   `document.fonts.ready` and two animation frames, and answers `breatic-frame-ready {session, sequence}` when no
 *   later seek has arrived in between.
 *
 * Shared so the host side in web drives the same script in its own tests.
 */

/** The bridge, as the source text the runner inlines. */
export const WEB_ANIMATION_BRIDGE_SCRIPT = `(function () {
  "use strict";
  var ready = false;
  var latest = 0;
  function post(message) {
    window.parent.postMessage(message, "*");
  }
  function checkReady() {
    if (ready) return;
    if (window.__playerReady === true) {
      ready = true;
      post({ type: "breatic-bridge-ready" });
      return;
    }
    setTimeout(checkReady, 20);
  }
  function fontsReady() {
    var fonts = window.document && window.document.fonts;
    return fonts && fonts.ready ? Promise.resolve(fonts.ready) : Promise.resolve();
  }
  function seek(data) {
    var token = ++latest;
    window.__player.renderSeek(data.time);
    fontsReady().then(function () {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () {
          if (token === latest) post({ type: "breatic-frame-ready", session: data.session, sequence: data.sequence });
        });
      });
    });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (typeof data !== "object" || data === null) return;
    if (data.type === "breatic-hello") {
      if (ready) post({ type: "breatic-bridge-ready" });
      return;
    }
    if (data.type !== "breatic-seek") return;
    if (typeof data.time !== "number" || !isFinite(data.time)) return;
    if (typeof data.session !== "string" && typeof data.session !== "number") return;
    if (typeof data.sequence !== "number") return;
    if (!ready || !window.__player || typeof window.__player.renderSeek !== "function") return;
    seek(data);
  });
  checkReady();
})();
`;
