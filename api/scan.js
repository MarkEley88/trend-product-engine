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
  const items = [];
  const matches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of matches.slice(0, limit)) {
    const title = clean((block.match(/<title>([\s\S]*?)<\/title>/i) || [,''])[1]);
    const link = clean((block.match(/<link>([\s\S]*?)<\/link>/i) || [,''])[1]);
    const pubDate = clean((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [,''])[1]);
    if (title) items.push({ title, link, pubDate });
  }
  return items;
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'TrendProductEngine/0.1' } });
  if (!response.ok) throw new Error(`Source returned ${response.status}`);
  return response.text();
}

async function googleNews(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`;
    return rssItems(await fetchText(url), 8).map(x => ({ ...x, source: 'Google News' }));
  } catch (error) {
    console.error('Google News failed:', error.message);
    return [];
  }
}

async function googleTrends() {
  try {
    const xml = await fetchText('https://trends.google.com/trending/rss?geo=GB');
    return rssItems(xml, 25).map(x => ({ ...x, source: 'Google Trends', signalType: 'trending search' }));
  } catch (error) {
    console.error('Google Trends failed:', error.message);
    return [];
  }
}

async function youtubeSearch(query) {
  if (!process.env.YOUTUBE_API_KEY) return [];
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=10&q=${encodeURIComponent(query)}&regionCode=GB&relevanceLanguage=en&key=${encodeURIComponent(process.env.YOUTUBE_API_KEY)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`YouTube returned ${response.status}`);
    const data = await response.json();
    return (data.items || []).map(item => ({ title: item.snippet?.title || '', link: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : '', publishedAt: item.snippet?.publishedAt || '', channel: item.snippet?.channelTitle || '', source: 'YouTube' }));
  } catch (error) {
    console.error('YouTube failed:', error.message);
    return [];
  }
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function text(value, fallback = '') {
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value && typeof value === 'object') {
    if (typeof value.detail === 'string') return value.detail;
    if (typeof value.text === 'string') return value.text;
    return JSON.stringify(value);
  }
  return fallback;
}

function normalizeEvidence(value, defaultSource = 'AI analysis') {
  return toArray(value).map(item => {
    if (typeof item === 'string') return { source: defaultSource, detail: item };
    return { source: text(item?.source, defaultSource), detail: text(item?.detail || item?.text, text(item)) };
  }).filter(x => x.detail);
}

function normalizeSources(value) {
  return toArray(value).map(item => {
    if (typeof item === 'string') return item;
    return item?.url || item?.link || '';
  }).filter(url => /^https?:\/\//i.test(url)).slice(0, 4);
}

function normalizeOpportunity(item, index) {
  const allowedScores = new Set(['High potential', 'Medium-high', 'Medium', 'Needs evidence']);
  const evidence = normalizeEvidence(item?.evidence);
  const complaints = normalizeEvidence(item?.complaintsEvidence);
  const gap = text(item?.gap, 'More product-review/comment evidence needed');
  const unprovenRaw = item?.unproven;
  const unproven = typeof unprovenRaw === 'boolean'
    ? (unprovenRaw ? 'This remains unproven and needs further investigation.' : 'No specific unresolved uncertainty was returned.')
    : text(unprovenRaw, 'The strongest customer complaint, willingness to pay and product gap still need validation.');

  return {
    category: text(item?.category, 'Uncategorised'),
    title: text(item?.title, `Potential opportunity ${index + 1}`),
    problem: text(item?.problem, 'A specific human problem needs further definition.'),
    trend: text(item?.trend, 'Signal identified in the supplied research.'),
    score: allowedScores.has(item?.score) ? item.score : 'Needs evidence',
    confidence: Math.max(1, Math.min(10, Number.parseInt(item?.confidence, 10) || 1)),
    evidence: evidence.slice(0, 5),
    products: text(item?.products, 'No sufficiently specific existing products were identified in the supplied evidence.'),
    complaintsEvidence: complaints.slice(0, 4),
    gap,
    unproven,
    audience: text(item?.audience, 'Audience needs further investigation.'),
    ads: text(item?.ads, 'Advertising channels need further investigation.'),
    sell: text(item?.sell, 'Sales channels need further investigation.'),
    next: text(item?.next, 'Collect product-review and customer-comment evidence before making a product decision.'),
    sources: normalizeSources(item?.sources)
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message: 'GET only' });
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ message: 'OPENAI_API_KEY is not available to this deployment. Add it to the Production environment and redeploy.', opportunities: [], sources: [] });

  let stage = 'starting';
  try {
    stage = 'collecting Google Trends';
    const trendItems = await googleTrends();
    const sourceResults = [];

    stage = 'collecting Google News and YouTube signals';
    for (const group of categories) {
      for (const query of group.queries.slice(0, 2)) {
        const [news, youtube] = await Promise.all([googleNews(`${query} how to OR problem OR fix`), youtubeSearch(query)]);
        sourceResults.push({ category: group.category, query, news, youtube });
      }
    }

    const rawSignals = { googleTrends: trendItems, categoryResearch: sourceResults };
    const compact = JSON.stringify(rawSignals).slice(0, 28000);

    stage = 'calling OpenAI';
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const prompt = `You are an evidence-led commercial product opportunity discovery analyst. Analyse the supplied live public-web signals and find 8-12 potential product opportunities across Automotive, Home & DIY, Pets and Travel.

The current data sources are Google Trends and Google News, plus YouTube only if a YouTube API key is configured. IMPORTANT: these sources do NOT contain product reviews or customer comments. Therefore you MUST NOT claim that a customer complaint has been verified unless it is explicitly present in the supplied data.

Required chain: SIGNAL -> SPECIFIC HUMAN PROBLEM -> EXISTING PRODUCTS -> VERIFIED/OBSERVED CUSTOMER COMPLAINTS OR GAP -> POTENTIAL PRODUCT OPPORTUNITY -> TEST.

Rules:
- Start each opportunity with a specific human problem, not a product category.
- Only state a demand signal when the supplied data supports it. Name the signal/source in evidence.
- Never invent search volumes, growth percentages, product names, prices, review counts, customer complaints or market facts.
- Existing products may be described only as product types supported by the supplied data. Do not invent brands or product specifications.
- Because this scan has no review/comment source, complaintsEvidence MUST be an empty array for every opportunity.
- Because customer complaints are not available, gap MUST describe the evidence gap rather than inventing a product gap.
- Keep observed evidence separate from AI interpretation.
- A potential opportunity is not guaranteed demand.
- Score is directional and based only on breadth/strength of the supplied evidence, not commercial success probability.
- Use one of: High potential, Medium-high, Medium, Needs evidence.
- confidence is 1-10 and measures evidence strength, not likelihood of success.
- evidence must contain 2-5 factual observations with source and detail.
- sources must contain exact URLs from supplied data only.
- Return ONLY valid JSON with key opportunities.
- Each opportunity must have exactly: category,title,problem,trend,score,confidence,evidence,products,complaintsEvidence,gap,unproven,audience,ads,sell,next,sources.

Data: ${compact}`;

    const response = await client.chat.completions.create({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return structured evidence-led commercial research. Never fabricate sources, prices, demand, products or customer complaints.' },
        { role: 'user', content: prompt }
      ]
    });

    stage = 'processing OpenAI response';
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned an empty response');
    const parsed = JSON.parse(content);
    const opportunities = toArray(parsed?.opportunities).map(normalizeOpportunity).filter(x => x.title);

    return res.status(200).json({
      opportunities,
      scannedAt: new Date().toISOString(),
      sourceCoverage: {
        googleTrends: trendItems.length,
        googleNews: sourceResults.reduce((n, x) => n + x.news.length, 0),
        youtube: sourceResults.reduce((n, x) => n + x.youtube.length, 0),
        youtubeEnabled: Boolean(process.env.YOUTUBE_API_KEY),
        model
      }
    });
  } catch (error) {
    console.error(`Live scan failed at ${stage}:`, error);
    const detail = error?.status === 401 ? 'OpenAI rejected the API key.' : error?.status === 429 ? 'OpenAI rate limit or billing limit reached.' : error?.message || 'Unknown error';
    return res.status(500).json({ message: `Live scan failed while ${stage}: ${detail}`, stage });
  }
};
