// Vercel Serverless Function — runs on Vercel's servers, NOT in the browser.
// Your eBay keys live in Vercel Environment Variables (server-side only),
// so they are never exposed to users. The browser calls THIS function,
// and this function calls eBay.
//
// Endpoint: /api/deals?q=Charizard%20PSA%209&value=120
//   q     = the card search query
//   value = your model's predicted value, to compute discount %

// --- simple in-memory token cache (persists while the function stays warm) ---
let cachedToken = null;
let tokenExpiresAt = 0;

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

async function searchEbay(query, token) {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "40");
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

function toListings(data, predictedValue) {
  const items = data.itemSummaries || [];
  const rows = [];

  for (const item of items) {
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

  // filter out suspiciously low outliers, then rank by best discount
  const filtered = rows.filter(r =>
    predictedValue <= 0 || r.total_price >= predictedValue * 0.15
  );
  filtered.sort((a, b) => (b.discount_percent ?? -999) - (a.discount_percent ?? -999));
  return filtered.slice(0, 3);  // top 3 deals
}

// Vercel serverless handler
export default async function handler(req, res) {
  // allow the browser to call this
  res.setHeader("Access-Control-Allow-Origin", "*");

  const query = (req.query.q || "").toString().trim();
  const value = parseFloat(req.query.value || "0");

  if (!query) {
    return res.status(400).json({ error: "Missing card query (?q=...)" });
  }

  try {
    const token = await getEbayToken();
    const data = await searchEbay(query, token);
    const deals = toListings(data, value);
    // cache results at the edge for 10 min so repeat searches are fast & cheap
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate");
    return res.status(200).json({ query, predicted_value: value, deals });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
