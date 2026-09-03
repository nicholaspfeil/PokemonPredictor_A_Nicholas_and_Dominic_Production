// Vercel Serverless Function — runs on Vercel's servers, NOT in the browser.
// Your eBay keys live in Vercel Environment Variables (server-side only),
// so they are never exposed to users. The browser calls THIS function,
// and this function calls eBay.
//
// Endpoint: /api/deals?q=Master%20Ball&value=42&set=Temporal%20Forces&set_code=SV05&number=175%2F162&rarity=ACE%20SPEC%20Rare
//   q        = card name
//   value    = your model's predicted value, to compute discount %
//   set      = set name (optional but strongly recommended)
//   set_code = set code, e.g. "SV05" (optional)
//   number   = card number, e.g. "175/162" (optional)
//   rarity   = card rarity (optional, currently informational only)
//   debug    = "1" to also return why each candidate was kept/rejected
//              (use this to diagnose a specific card that returns nothing)
 
// --- simple in-memory token cache (persists while the function stays warm) ---
let cachedToken = null;
let tokenExpiresAt = 0;
 
// eBay category: Toys & Hobbies > Collectible Card Games > Pokémon TCG >
// "Pokémon Individual Cards". This is a best-effort ID, not something we can
// verify without hitting the live API — treat it as a narrowing filter we
// fall back off of, not a hard requirement. Some real listings get
// miscategorized by sellers anyway, so it should never be the only thing
// standing between a card and a "no results" outcome.
const EBAY_POKEMON_SINGLES_CATEGORY = "183454";
 
async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }
 
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) {
    throw new Error("Missing eBay credentials in server environment.");
  }
 
  const creds = Buffer.from(`${appId}:${certId}`).toString("base64");
 
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });
 
  if (!res.ok) {
    throw new Error(`eBay auth failed: ${res.status}`);
  }
 
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}
 
// ---- Build a specific eBay search term from every identifier we have ----
function buildSearchQuery(card) {
  const parts = [card.name];
  if (card.set) parts.push(card.set);
  else if (card.setCode) parts.push(card.setCode);
  if (card.number) {
    const numerator = String(card.number).split("/")[0].trim();
    if (numerator) parts.push(numerator);
  }
  return parts.filter(Boolean).join(" ");
}
 
// IMPORTANT: no `sort` param here — omitting it uses eBay's "best match"
// relevance ranking. Sorting by price instead (the earlier version) pulls in
// the 50 *cheapest* items matching loose keywords, which for a category-wide
// search skews heavily toward off-target junk — starving the relevance
// filter below of anything real to keep. Price ranking happens on OUR side,
// after we know a listing is actually the right card.
async function searchEbay(query, token, { useCategory = true } = {}) {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", query);
  if (useCategory) url.searchParams.set("category_ids", EBAY_POKEMON_SINGLES_CATEGORY);
  url.searchParams.set("limit", "50");
  url.searchParams.set("filter", "buyingOptions:{FIXED_PRICE}");
 
  const res = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });
 
  if (!res.ok) {
    throw new Error(`eBay search failed: ${res.status}`);
  }
  return res.json();
}
 
// ---- Listing verification ----
function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
 
const NAME_STOPWORDS = new Set(["the", "a", "an", "of", "and"]);
 
const NON_SINGLE_CARD_TERMS = [
  "plush", "plushie", "figure", "funko", "pop!", "keychain", "key chain",
  "playmat", "play mat", "sleeve", "sleeves", "binder", "deck box",
  "poster", "sticker", "patch", "pin ", "pins", "backpack",
  "proxy", "proxies", "custom card", "fan art", "fanart", "replica",
  "code card", "online code", "digital code", "tcg online", "tcgo code",
  "lot of", "bundle", "bulk lot", "mystery box",
  "booster box", "booster pack", "elite trainer box", " etb ",
];
 
function wordPresent(text, tok) {
  return new RegExp(`\\b${tok}\\b`).test(text);
}
 
// Returns { ok, reason } instead of a plain boolean so failures are
// diagnosable via ?debug=1 instead of being a black box.
function checkListing(title, card) {
  const t = ` ${normalize(title)} `;
 
  const badTerm = NON_SINGLE_CARD_TERMS.find(term => t.includes(term));
  if (badTerm) return { ok: false, reason: `matched non-card term "${badTerm.trim()}"` };
 
  const nameTokens = normalize(card.name)
    .split(" ")
    .filter(w => w && !NAME_STOPWORDS.has(w));
  if (!nameTokens.length) return { ok: false, reason: "card has no usable name" };
 
  const missingName = nameTokens.find(tok => !wordPresent(t, tok));
  if (missingName) return { ok: false, reason: `title missing name word "${missingName}"` };
 
  // Identifiers that can independently confirm this exact print. Set/number
  // are checked word-by-word (not as one exact phrase) so different word
  // order or punctuation in the title doesn't cause a false rejection.
  const setTokens = card.set
    ? normalize(card.set).split(" ").filter(w => w && !NAME_STOPWORDS.has(w))
    : [];
  const setMatches = setTokens.length > 0 && setTokens.every(tok => wordPresent(t, tok));
 
  const codeVariants = [];
  if (card.setCode) {
    const code = normalize(card.setCode);
    codeVariants.push(code, code.replace(/0(\d)/, "$1")); // SV05 -> SV5 style
  }
  const codeMatches = codeVariants.some(c => c && t.includes(c));
 
  const numerator = card.number ? String(card.number).split("/")[0].trim() : "";
  const numberMatches = numerator ? wordPresent(t, numerator) : false;
 
  const hasAnyIdentifier = setTokens.length || codeVariants.length || numerator;
  if (!hasAnyIdentifier) {
    // Nothing to check against beyond the name — accept, but this is the
    // weakest guarantee we can offer for this card (see debug output).
    return { ok: true, reason: "accepted on name only (no set/number supplied)" };
  }
 
  if (setMatches) return { ok: true, reason: "matched on set name" };
  if (codeMatches) return { ok: true, reason: "matched on set code" };
  if (numberMatches) return { ok: true, reason: "matched on card number" };
 
  return {
    ok: false,
    reason: "name matched but no set/code/number confirmation found in title",
  };
}
 
function scoreListing(item, predictedValue) {
  const priceInfo = item.price || {};
  const price = parseFloat(priceInfo.value);
  if (!price || price <= 0) return null;
 
  let shipping = 0;
  const opts = item.shippingOptions || [];
  if (opts.length && opts[0].shippingCost) {
    shipping = parseFloat(opts[0].shippingCost.value || 0);
  }
  const total = price + shipping;
 
  let discount = null;
  if (predictedValue > 0) {
    discount = ((predictedValue - total) / predictedValue) * 100;
  }
 
  return {
    title: item.title,
    price,
    shipping,
    total_price: parseFloat(total.toFixed(2)),
    condition: item.condition || "—",
    url: item.itemWebUrl,
    image: (item.image || {}).imageUrl || "",
    discount_percent: discount === null ? null : parseFloat(discount.toFixed(1)),
  };
}
 
// Runs one search + verify pass. Returns { verified, debugCandidates }.
async function runSearch(searchTerm, token, card, predictedValue, useCategory) {
  const data = await searchEbay(searchTerm, token, { useCategory });
  const items = data.itemSummaries || [];
 
  const verified = [];
  const debugCandidates = [];
 
  for (const item of items) {
    const check = checkListing(item.title, card);
    if (check.ok) {
      const row = scoreListing(item, predictedValue);
      if (row) verified.push(row);
    }
    debugCandidates.push({
      title: item.title,
      price: (item.price || {}).value ?? null,
      verified: check.ok,
      reason: check.reason,
    });
  }
 
  return { verified, debugCandidates };
}
 
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
 
  const query = (req.query.q || "").toString().trim();
  const value = parseFloat(req.query.value || "0");
  const wantDebug = req.query.debug === "1" || req.query.debug === "true";
  const card = {
    name: query,
    set: (req.query.set || "").toString().trim(),
    setCode: (req.query.set_code || "").toString().trim(),
    number: (req.query.number || "").toString().trim(),
    rarity: (req.query.rarity || "").toString().trim(),
  };
 
  if (!query) {
    return res.status(400).json({ error: "Missing card query (?q=...)" });
  }
 
  try {
    const token = await getEbayToken();
    const searchTerm = buildSearchQuery(card);
 
    // Pass 1: narrowed to the Pokémon-singles category.
    let { verified, debugCandidates } = await runSearch(searchTerm, token, card, value, true);
    let usedCategoryFallback = false;
 
    // Pass 2 (fallback): if the category filter produced nothing verified,
    // retry without it. The title-verification step is what actually
    // guarantees correctness, so dropping the category restriction here
    // doesn't reopen the wrong-card bug — it just widens the candidate pool
    // in case the category ID was wrong or the listing was miscategorized.
    if (!verified.length) {
      const retry = await runSearch(searchTerm, token, card, value, false);
      verified = retry.verified;
      debugCandidates = debugCandidates.concat(retry.debugCandidates);
      usedCategoryFallback = true;
    }
 
    // Sanity floor against nonsense prices among the verified rows.
    const filtered = verified.filter(r => value <= 0 || r.total_price >= value * 0.15);
    filtered.sort((a, b) => (b.discount_percent ?? -999) - (a.discount_percent ?? -999));
    const deals = filtered.slice(0, 3);
 
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate");
    const payload = { query: searchTerm, predicted_value: value, deals };
    if (wantDebug) {
      payload.debug = {
        card,
        searchTerm,
        usedCategoryFallback,
        totalCandidates: debugCandidates.length,
        totalVerified: verified.length,
        candidates: debugCandidates.slice(0, 25),
      };
    }
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
