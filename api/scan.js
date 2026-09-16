const OpenAI = require('openai');

const categories = [
  { category: 'Automotive', queries: ['car detailing', 'car interior repair', 'car cleaning', 'car scratch repair'] },
  { category: 'Home & DIY', queries: ['home organisation', 'kitchen storage', 'DIY home improvement', 'small space storage'] },
  { category: 'Pets', queries: ['dog grooming', 'dog nail trimming', 'pet cleaning', 'dog behaviour training'] },
  { category: 'Travel', queries: ['family travel', 'travel packing', 'airport travel with kids', 'travel organisation'] }
];

function clean(value = '') {
  return String(value).replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}
function rssItems(xml, limit = 12) {
  const items = []; const matches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of matches.slice(0, limit)) {
    const title = clean((block.match(/<title>([\s\S]*?)<\/title>/i) || [,''])[1]);
    const link = clean((block.match(/<link>([\s\S]*?)<\/link>/i) || [,''])[1]);
    const pubDate = clean((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [,''])[1]);
    if (title) items.push({ title, link, pubDate });
  }
  return items;
}
async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'TrendProductEngine/0.2' } });
  if (!response.ok) throw new Error(`Source returned ${response.status}`);
  return response.text();
}
async function googleNews(query, limit = 8) {
  try { const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`; return rssItems(await fetchText(url), limit).map(x => ({ ...x, source: 'Google News' })); }
  catch (e) { console.error('Google News failed:', e.message); return []; }
}
async function googleTrends() {
  try { return rssItems(await fetchText('https://trends.google.com/trending/rss?geo=GB'), 25).map(x => ({ ...x, source: 'Google Trends', signalType: 'trending search' })); }
  catch (e) { console.error('Google Trends failed:', e.message); return []; }
}
async function redditSearch(query) {
  try { const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&limit=8`; return rssItems(await fetchText(url), 8).map(x => ({ ...x, source: 'Reddit' })); }
  catch (e) { console.error('Reddit failed:', e.message); return []; }
}
async function youtubeSearch(query) {
  if (!process.env.YOUTUBE_API_KEY) return [];
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=10&q=${encodeURIComponent(query)}&regionCode=GB&relevanceLanguage=en&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`;
    const response = await fetch(url); if (!response.ok) throw new Error(`YouTube returned ${response.status}`); const data = await response.json();
    return (data.items || []).map(item => ({ title: item.snippet?.title || '', link: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : '', publishedAt: item.snippet?.publishedAt || '', channel: item.snippet?.channelTitle || '', source: 'YouTube' }));
  } catch (e) { console.error('YouTube failed:', e.message); return []; }
}
function toArray(value) { if (Array.isArray(value)) return value; if (value == null || value === '') return []; return [value]; }
function text(value, fallback = '') {
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value && typeof value === 'object') { if (typeof value.detail === 'string') return value.detail; if (typeof value.text === 'string') return value.text; return JSON.stringify(value); }
  return fallback;
}
function normalizeEvidence(value, defaultSource = 'AI analysis') {
  return toArray(value).map(item => typeof item === 'string' ? { source: defaultSource, detail: item } : { source: text(item?.source, defaultSource), detail: text(item?.detail || item?.text, text(item)) }).filter(x => x.detail);
}
function normalizeSources(value) { return toArray(value).map(item => typeof item === 'string' ? item : item?.url || item?.link || '').filter(url => /^https?:\/\//i.test(url)).slice(0, 6); }
function normalizeOpportunity(item, index) {
  const allowedScores = new Set(['High potential', 'Medium-high', 'Medium', 'Needs evidence']);
  const evidence = normalizeEvidence(item?.evidence), complaints = normalizeEvidence(item?.complaintsEvidence);
  return {
    category: text(item?.category, 'Uncategorised'), title: text(item?.title, `Potential opportunity ${index + 1}`), problem: text(item?.problem, 'A specific human problem needs further definition.'), trend: text(item?.trend, 'Signal identified in the supplied research.'), score: allowedScores.has(item?.score) ? item.score : 'Needs evidence', confidence: Math.max(1, Math.min(10, Number.parseInt(item?.confidence, 10) || 1)), evidence: evidence.slice(0, 6), products: text(item?.products, 'No sufficiently specific existing products were identified.'), complaintsEvidence: complaints.slice(0, 5), gap: text(item?.gap, 'No verified product gap yet; collect more review and discussion evidence.'), unproven: text(item?.unproven, 'The strongest unresolved complaint, willingness to pay and product gap still need validation.'), audience: text(item?.audience, 'Audience needs further investigation.'), ads: text(item?.ads, 'Advertising channels need further investigation.'), sell: text(item?.sell, 'Sales channels need further investigation.'), next: text(item?.next, 'Collect more product-review and customer-discussion evidence before making a product decision.'), sources: normalizeSources(item?.sources)
  };
}
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message: 'GET only' });
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ message: 'OPENAI_API_KEY is not available to this deployment. Add it to the Production environment and redeploy.', opportunities: [], sources: [] });
  let stage = 'starting';
  try {
    stage = 'collecting Google Trends'; const trendItems = await googleTrends(); const sourceResults = [];
    stage = 'collecting discovery, complaint and review signals';
    for (const group of categories) for (const query of group.queries.slice(0, 2)) {
      const [news, reviews, reddit, youtube] = await Promise.all([googleNews(`${query} how to OR problem OR fix`, 8), googleNews(`${query} review OR reviews OR complaint OR complaints`, 8), redditSearch(`${query} problem OR issue OR recommendation OR review`), youtubeSearch(query)]);
      sourceResults.push({ category: group.category, query, news, reviews, reddit, youtube });
    }
    const compact = JSON.stringify({ googleTrends: trendItems, categoryResearch: sourceResults }).slice(0, 50000);
    stage = 'calling OpenAI'; const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const prompt = `You are an evidence-led commercial product opportunity discovery analyst. Analyse the supplied live public-web signals and identify genuinely specific potential product opportunities across Automotive, Home & DIY, Pets and Travel.

This is NOT a content-idea generator. Do not simply return the four broad category themes. A category/topic is only a discovery signal. The final opportunity must describe a concrete human problem that could plausibly be solved by a product.

Required chain: SIGNAL -> SPECIFIC HUMAN PROBLEM -> EXISTING SOLUTIONS/PRODUCT TYPES -> OBSERVED CUSTOMER COMPLAINT OR UNMET NEED -> POTENTIAL PRODUCT OPPORTUNITY -> TEST

Rules:
- Every opportunity must have at least 2 independent factual evidence items.
- At least one evidence item must relate directly to the specific problem, complaint, review, discussion or unmet need.
- Prefer Reddit/customer discussion and review/complaint search results for complaint evidence.
- Google News and Google Trends are demand/context signals, not customer complaint evidence by themselves.
- Never invent search volumes, growth percentages, products, brands, prices, review counts, complaints, market facts or sentiment.
- Existing products must be described only at the level supported by the supplied data.
- If evidence is too generic, conflicting or weak, DO NOT create an opportunity.
- Do not force one opportunity per category. Fewer than 8 is acceptable if that is all the evidence supports.
- Do not use broad titles such as Rising costs of family travel, Struggles with home organisation, dog grooming concerns, or similar category statements unless evidence identifies a much more specific problem underneath.
- Score is an evidence-strength label, not a prediction of commercial success. confidence is evidence strength only.
- A potential opportunity is not guaranteed demand.

Return ONLY valid JSON with key opportunities. Each opportunity must have exactly: category,title,problem,trend,score,confidence,evidence,products,complaintsEvidence,gap,unproven,audience,ads,sell,next,sources.
- evidence: 2-6 factual observations, each with source and detail.
- complaintsEvidence: 1-5 factual observations from Reddit, review/complaint results or another direct customer source. If none exists, reject the opportunity.
- gap: explain the observed unresolved need; if not verified, explicitly say what is missing.
- sources: exact URLs from supplied data only.

Data: ${compact}`;
    const response = await client.chat.completions.create({ model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Return structured evidence-led commercial research. Never fabricate sources, prices, demand, products or customer complaints.' }, { role: 'user', content: prompt }] });
    stage = 'processing OpenAI response'; const content = response.choices?.[0]?.message?.content; if (!content) throw new Error('OpenAI returned an empty response');
    const parsed = JSON.parse(content); const opportunities = toArray(parsed?.opportunities).map(normalizeOpportunity).filter(x => x.title && x.evidence.length >= 2 && x.complaintsEvidence.length >= 1 && x.sources.length >= 2);
    return res.status(200).json({ opportunities, scannedAt: new Date().toISOString(), sourceCoverage: { googleTrends: trendItems.length, googleNews: sourceResults.reduce((n, x) => n + x.news.length + x.reviews.length, 0), reddit: sourceResults.reduce((n, x) => n + x.reddit.length, 0), youtube: sourceResults.reduce((n, x) => n + x.youtube.length, 0), youtubeEnabled: Boolean(process.env.YOUTUBE_API_KEY), model }, message: opportunities.length ? undefined : 'The scan found signals but not enough specific, independently supported product opportunities yet.' });
  } catch (error) {
    console.error(`Live scan failed at ${stage}:`, error); const detail = error?.status === 401 ? 'OpenAI rejected the API key.' : error?.status === 429 ? 'OpenAI rate limit or billing limit reached.' : error?.message || 'Unknown error'; return res.status(500).json({ message: `Live scan failed while ${stage}: ${detail}`, stage });
  }
};
