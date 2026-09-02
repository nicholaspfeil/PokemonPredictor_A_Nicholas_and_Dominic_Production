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
//
// WHY THIS FILE WAS REWRITTEN:
// Card names are not unique ("Master Ball" is reused across sets and even
// exists as non-card merchandise). The old version searched eBay using ONLY
// the bare name, applied no category restriction, and ranked purely by
// discount percent — so a cheap, completely wrong item could out-rank the
// real card just by having a low price relative to the predicted value.
// This version (1) builds a more specific query from every identifier the
// front end already sends, (2) restricts the search to eBay's actual
// Pokémon-singles category, and (3) verifies each listing's title against
// the card's identity before it's even eligible to be ranked. Unverified
// listings are dropped rather than shown — a short/empty result list is
// preferred over a wrong one.

// --- simple in-memory token cache (persists while the function stays warm) ---
let cachedToken = null;
let tokenExpiresAt = 0;

// eBay category: Toys & Hobbies > Collectible Card Games > Pokémon TCG >
// "Pokémon Individual Cards". Restricting to this category alone rules out
// other card games, sealed product, video games, and general merchandise
// that a bare keyword search would otherwise happily return.
const EBAY_POKEMON_SINGLES_CATEGORY = "183454";

async function getEbayToken() {
  // reuse the token if it's still valid (avoids re-authing every request)
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const appId = process.env.EBAY_APP_ID;      // set in Vercel env vars
  const certId = process.env.EBAY_CERT_ID;    // set in Vercel env vars
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
  // refresh a bit before the real expiry (data.expires_in is in seconds)
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ---- Build a specific eBay search term from every identifier we have ----
function buildSearchQuery(card) {
  const parts = [card.name];
  if (card.set) parts.push(card.set);
  else if (card.setCode) parts.push(card.setCode);
  if (card.number) {
    // Sellers write the numerator inconsistently ("175", "175/162", "#175"),
    // so search on the numerator alone rather than the full "x/y" string.
    const numerator = String(card.number).split("/")[0].trim();
    if (numerator) parts.push(numerator);
  }
  return parts.filter(Boolean).join(" ");
}

async function searchEbay(query, token) {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", query);
  url.searchParams.set("category_ids", EBAY_POKEMON_SINGLES_CATEGORY);
  url.searchParams.set("limit", "50");
  url.searchParams.set("sort", "price");
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
// A listing only becomes eligible to be ranked as a "deal" if its title
// checks out against the card's identity. This is what actually fixes the
// wrong-card bug — the old code trusted eBay's keyword match completely.

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/]/g, " ") // strip punctuation, keep "/" for card numbers
    .replace(/\s+/g, " ")
    .trim();
}

const NAME_STOPWORDS = new Set(["the", "a", "an", "of", "and"]);

// Listing types that are never the single card itself, however well the
// keywords happen to match.
const NON_SINGLE_CARD_TERMS = [
  "plush", "plushie", "figure", "funko", "pop!", "keychain", "key chain",
  "playmat", "play mat", "sleeve", "sleeves", "binder", "deck box",
  "poster", "sticker", "patch", "pin ", "pins", "backpack",
  "proxy", "proxies", "custom card", "fan art", "fanart", "replica",
  "code card", "online code", "digital code", "tcg online", "tcgo code",
  "lot of", "bundle", "bulk lot", "mystery box",
  "booster box", "booster pack", "elite trainer box", " etb ",
];

function isRelevantListing(title, card) {
  const t = ` ${normalize(title)} `;

  if (NON_SINGLE_CARD_TERMS.some(term => t.includes(term))) return false;

  // Every meaningful word of the card's name must appear in the title.
  const nameTokens = normalize(card.name)
    .split(" ")
    .filter(w => w && !NAME_STOPWORDS.has(w));
  if (!nameTokens.length) return false;
  const allNameTokensPresent = nameTokens.every(tok =>
    new RegExp(`\\b${tok}\\b`).test(t)
  );
  if (!allNameTokensPresent) return false;

  // A shared name isn't enough on its own — "Master Ball" exists across
  // multiple sets/rarities. Require at least one independent identifier
  // (set name, set code, or card number) to confirm it's this exact print.
  const identifiers = [];
  if (card.set) identifiers.push(normalize(card.set));
  if (card.setCode) {
    const code = normalize(card.setCode);
    identifiers.push(code);
    // also accept the no-leading-zero form sellers commonly use (SV05 -> SV5)
    identifiers.push(code.replace(/0(\d)/, "$1"));
  }
  if (card.number) {
    const numerator = String(card.number).split("/")[0].trim();
    if (numerator) identifiers.push(numerator);
  }

  if (!identifiers.length) {
    // No identifying info was supplied for this card — fall back to a
    // name-only match rather than rejecting everything outright.
    return true;
  }

  return identifiers.some(id => id && t.includes(id));
}

function toListings(data, predictedValue, card) {
  const items = data.itemSummaries || [];
  const rows = [];

  for (const item of items) {
    if (!isRelevantListing(item.title, card)) continue; // reject unverified matches outright

    const priceInfo = item.price || {};
    const price = parseFloat(priceInfo.value);
    if (!price || price <= 0) continue;

    let shipping = 0;
    const opts = item.shippingOptions || [];
    if (opts.length && opts[0].shippingCost) {
      shipping = parseFloat(opts[0].shippingCost.value || 0);
    }
    const total = price + shipping;

    // discount vs the model's predicted value (positive = below value)
    let discount = null;
    if (predictedValue > 0) {
      discount = ((predictedValue - total) / predictedValue) * 100;
    }

    rows.push({
      title: item.title,
      price: price,
      shipping: shipping,
      total_price: parseFloat(total.toFixed(2)),
      condition: item.condition || "—",
      url: item.itemWebUrl,
      image: (item.image || {}).imageUrl || "",
      discount_percent: discount === null ? null : parseFloat(discount.toFixed(1)),
    });
  }

  // sanity floor: still guard against nonsense prices among the verified rows
  const filtered = rows.filter(r =>
    predictedValue <= 0 || r.total_price >= predictedValue * 0.15
  );
  filtered.sort((a, b) => (b.discount_percent ?? -999) - (a.discount_percent ?? -999));
  return filtered.slice(0, 3); // top 3 *verified* deals — never backfilled with unverified ones
}

// Vercel serverless handler
export default async function handler(req, res) {
  // allow the browser to call this
  res.setHeader("Access-Control-Allow-Origin", "*");

  const query = (req.query.q || "").toString().trim();
  const value = parseFloat(req.query.value || "0");
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
    const data = await searchEbay(searchTerm, token);
    const deals = toListings(data, value, card);
    // cache results at the edge for 10 min so repeat searches are fast & cheap
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate");
    return res.status(200).json({ query: searchTerm, predicted_value: value, deals });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
