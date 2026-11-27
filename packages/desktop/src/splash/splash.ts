// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The splash page (inner#2041, design §5.2). The main process names the product,
 * the logo file and whether the attribution line shows in the page's
 * address; the page shows them and nothing else.
 */

/** The platform a partner's build runs on, named on its splash as the contract requires. */
const ATTRIBUTION = "Breatic";

const params = new URLSearchParams(window.location.search);
const product = params.get("product") ?? "";
document.title = product;
(document.getElementById("name") as HTMLElement).textContent = product;
(document.getElementById("logo") as HTMLImageElement).src = params.get("logo") ?? "";
if (params.get("poweredBy") === "1") {
  (document.getElementById("powered-name") as HTMLElement).textContent = ATTRIBUTION;
  (document.getElementById("powered") as HTMLElement).hidden = false;
}
