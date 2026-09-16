const OpenAI = require('openai');

const categories = [
  { category: 'Automotive', queries: ['car interior plastic restoration', 'car detailing mistakes damage', 'car scratch repair DIY', 'car cleaning difficult problems'] },
  { category: 'Home & DIY', queries: ['kitchen storage clutter appliances', 'small kitchen storage problems', 'home organisation storage problems', 'under sink storage problems'] },
  { category: 'Pets', queries: ['dog nail trimming difficult', 'dog grooming at home problems', 'dog hair cleaning difficult', 'pet grooming tool problems'] },
  { category: 'Travel', queries: ['family travel packing problems', 'travelling with kids airport problems', 'family travel organisation problems', 'airplane travel with kids difficult'] }
];

function clean(value = '') { return String(value).replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim(); }
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
async function fetchText(url) { const response = await fetch(url, { headers: { 'User-Agent': 'TrendProductEngine/0.4' } }); if (!response.ok) throw new Error(`Source returned ${response.status}`); return response.text(); }
async function googleNews(query, limit = 8, signalType = 'discovery') {
  try { const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`; return rssItems(await fetchText(url), limit).map(x => ({ ...x, source: 'Google News', signalType })); }
  catch (e) { console.error('Google News failed:', e.message); return []; }
}
async function googleTrends() {
  try { return rssItems(await fetchText('https://trends.google.com/trending/rss?geo=GB'), 25).map(x => ({ ...x, source: 'Google Trends', signalType: 'trending search' })); }
  catch (e) { console.error('Google Trends failed:', e.message); return []; }
}
async function redditSearch(query) {
  const urls = [
    `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=8`,
    `https://old.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=8`
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'TrendProductEngine/0.4 research bot' } });
      if (!response.ok) continue;
      const data = await response.json();
      return (data?.data?.children || []).map(x => ({ title: x?.data?.title || '', link: x?.data?.permalink ? `https://www.reddit.com${x.data.permalink}` : '', pubDate: x?.data?.created_utc ? new Date(x.data.created_utc * 1000).toISOString() : '', source: 'Reddit', signalType: 'customer discussion' })).filter(x => x.title);
    } catch (e) { console.error('Reddit failed:', e.message); }
  }
  return [];
}
async function youtubeSearch(query) {
  if (!process.env.YOUTUBE_API_KEY) return [];
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=relevance&maxResults=10&q=${encodeURIComponent(query)}&regionCode=GB&relevanceLanguage=en&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`;
    const response = await fetch(url); if (!response.ok) throw new Error(`YouTube returned ${response.status}`); const data = await response.json();
    return (data.items || []).map(item => ({ title: item.snippet?.title || '', link: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : '', publishedAt: item.snippet?.publishedAt || '', channel: item.snippet?.channelTitle || '', source: 'YouTube', signalType: 'video content' }));
  } catch (e) { console.error('YouTube failed:', e.message); return []; }
}
function toArray(value) { if (Array.isArray(value)) return value; if (value == null || value === '') return []; return [value]; }
function text(value, fallback = '') { if (typeof value === 'string') return value.trim() || fallback; if (typeof value === 'number') return String(value); if (typeof value === 'boolean') return value ? 'Yes' : 'No'; if (value && typeof value === 'object') { if (typeof value.detail === 'string') return value.detail; if (typeof value.text === 'string') return value.text; return JSON.stringify(value); } return fallback; }
function normalizeEvidence(value, defaultSource = 'AI analysis') { return toArray(value).map(item => typeof item === 'string' ? { source: defaultSource, detail: item } : { source: text(item?.source, defaultSource), detail: text(item?.detail || item?.text, text(item)), url: text(item?.url, '') }).filter(x => x.detail); }
function normalizeSources(value) { return toArray(value).map(item => typeof item === 'string' ? item : item?.url || item?.link || '').filter(url => /^https?:\/\//i.test(url)).slice(0, 8); }
function normalizeOpportunity(item, index) {
  const allowedScores = new Set(['High potential', 'Medium-high', 'Medium', 'Needs evidence']);
  const evidence = normalizeEvidence(item?.evidence), complaints = normalizeEvidence(item?.complaintsEvidence);
  return { category: text(item?.category, 'Uncategorised'), title: text(item?.title, `Potential opportunity ${index + 1}`), problem: text(item?.problem, 'A specific human problem needs further definition.'), trend: text(item?.trend, 'Signal identified in the supplied research.'), score: allowedScores.has(item?.score) ? item.score : 'Needs evidence', confidence: Math.max(1, Math.min(10, Number.parseInt(item?.confidence, 10) || 1)), evidence: evidence.slice(0, 6), products: text(item?.products, 'No sufficiently specific existing solutions identified.'), complaintsEvidence: complaints.slice(0, 5), gap: text(item?.gap, 'No verified product gap yet; collect more customer evidence.'), unproven: text(item?.unproven, 'The strongest unresolved complaint, willingness to pay and product gap still need validation.'), audience: text(item?.audience, 'Audience needs further investigation.'), ads: text(item?.ads, 'Advertising channels need further investigation.'), sell: text(item?.sell, 'Sales channels need further investigation.'), next: text(item?.next, 'Collect more product-review and customer-discussion evidence before making a product decision.'), sources: normalizeSources(item?.sources) };
}
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message: 'GET only' });
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ message: 'OPENAI_API_KEY is not available to this deployment. Add it to the Production environment and redeploy.', opportunities: [], sources: [] });
  let stage = 'starting';
  try {
    stage = 'collecting Google Trends'; const trendItems = await googleTrends(); const sourceResults = [];
    stage = 'collecting problem, review and customer-discussion signals';
    for (const group of categories) for (const query of group.queries) {
      const [discovery, complaintSearch, reddit, youtube] = await Promise.all([
        googleNews(`"${query}" how to OR problem OR fix OR difficult`, 8, 'discovery'),
        googleNews(`"${query}" review OR reviews OR complaint OR complaints OR "doesn't work" OR annoying OR "wish"`, 8, 'review/complaint search'),
        redditSearch(`${query} problem OR issue OR recommendation OR review`),
        youtubeSearch(query)
      ]);
      sourceResults.push({ category: group.category, query, discovery, complaintSearch, reddit, youtube });
    }
    const rawSignals = { googleTrends: trendItems, categoryResearch: sourceResults };
    const compact = JSON.stringify(rawSignals).slice(0, 60000);
    stage = 'calling OpenAI'; const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const prompt = `You are the research engine for a commercial product discovery platform. Your job is to discover SPECIFIC, evidence-backed human problems that may reveal product opportunities.

Do NOT return broad topics or generic business ideas. "dog grooming", "home organisation", "family travel" and "car detailing" are research areas, NOT opportunities.

A useful result looks like: a clearly defined person + situation + recurring pain + evidence that the pain exists + existing solution/product context + an unresolved need that could plausibly be improved by a physical/digital product.

Required chain: TREND/SIGNAL -> SPECIFIC HUMAN PROBLEM -> EXISTING SOLUTIONS -> CUSTOMER VOICE / COMPLAINT -> UNRESOLVED NEED -> POTENTIAL PRODUCT CONCEPT -> TEST.

CRITICAL EVIDENCE RULES:
- Do not manufacture specificity from a generic article.
- Every opportunity needs 2+ independent evidence observations.
- At least one observation must be from a customer-discussion or review/complaint signal. Google News articles that merely report an expert warning or general trend are NOT customer voice.
- Reddit items are direct customer discussion signals. Items from the complaintSearch stream are review/complaint SEARCH signals and may be used, but describe them honestly as such.
- Do not claim a product is defective, unsafe, popular, profitable or poorly reviewed unless the supplied evidence actually says that.
- Never invent search volumes, growth rates, prices, brands, review counts, market sizes or customer sentiment.
- Existing products should be named only if the supplied data names them; otherwise describe the solution type.
- If the evidence only supports a broad theme, REJECT it.
- Do not force one result per category. It is fine to return 0, 1, 2 or many from one category and none from another.
- Avoid generic titles such as "Dog Grooming Safety Kits", "Compact Kitchen Storage Solutions", "Car Detailing Kits for Busy Parents" or "Rising Costs of Family Travel" unless the supplied evidence identifies a materially more specific recurring problem.
- A potential opportunity is not guaranteed demand.
- confidence measures evidence strength, not commercial success probability.

For every opportunity:
- title: specific problem/opportunity, ideally naming the task and pain point.
- problem: who is struggling, in what situation, and what goes wrong.
- trend: explain the discovery signal without exaggeration.
- evidence: 2-6 factual observations from supplied items. Each item MUST include source, detail and URL when available.
- complaintsEvidence: 1-5 observations specifically from Reddit or the review/complaint search stream. Each item MUST include source, detail and URL when available. If there is no credible customer voice, reject the opportunity.
- products: only existing solution/product types supported by evidence.
- gap: describe the specific unresolved need evidenced by the sources. Do not simply say "safer" or "better" without explaining what is missing.
- unproven: clearly state the biggest remaining commercial unknown.
- audience/ads/sell: only make claims supported by the research; otherwise say more evidence is needed.
- sources: exact URLs from supplied data only.

Return ONLY JSON: {"opportunities":[...]}. Each object must have exactly category,title,problem,trend,score,confidence,evidence,products,complaintsEvidence,gap,unproven,audience,ads,sell,next,sources.

DATA:\n${compact}`;
    const response = await client.chat.completions.create({ model, temperature: 0.05, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You are a strict evidence auditor. Never fabricate evidence. Reject generic opportunities.' }, { role: 'user', content: prompt }] });
    stage = 'processing OpenAI response'; const content = response.choices?.[0]?.message?.content; if (!content) throw new Error('OpenAI returned an empty response');
    const parsed = JSON.parse(content); const opportunities = toArray(parsed?.opportunities).map(normalizeOpportunity).filter(x => x.title && x.evidence.length >= 2 && x.complaintsEvidence.length >= 1 && x.sources.length >= 2);
    return res.status(200).json({ opportunities, scannedAt: new Date().toISOString(), sourceCoverage: { googleTrends: trendItems.length, googleNews: sourceResults.reduce((n, x) => n + x.discovery.length + x.complaintSearch.length, 0), reddit: sourceResults.reduce((n, x) => n + x.reddit.length, 0), youtube: sourceResults.reduce((n, x) => n + x.youtube.length, 0), youtubeEnabled: Boolean(process.env.YOUTUBE_API_KEY), model }, message: opportunities.length ? undefined : 'Signals were found, but the evidence did not meet the specificity threshold for a product opportunity.' });
  } catch (error) {
    console.error(`Live scan failed at ${stage}:`, error); const detail = error?.status === 401 ? 'OpenAI rejected the API key.' : error?.status === 429 ? 'OpenAI rate limit or billing limit reached.' : error?.message || 'Unknown error'; return res.status(500).json({ message: `Live scan failed while ${stage}: ${detail}`, stage });
  }
};
