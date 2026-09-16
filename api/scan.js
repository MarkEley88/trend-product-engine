const OpenAI = require('openai');

const categories = [
  { category: 'Automotive', queries: ['car detailing', 'car interior repair', 'car cleaning', 'car scratch repair'] },
  { category: 'Home & DIY', queries: ['home organisation', 'kitchen storage', 'DIY home improvement', 'small space storage'] },
  { category: 'Pets', queries: ['dog grooming', 'dog nail trimming', 'pet cleaning', 'dog behaviour training'] },
  { category: 'Travel', queries: ['family travel', 'travel packing', 'airport travel with kids', 'travel organisation'] }
];

function clean(value = '') {
  return value.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
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

IMPORTANT: Do NOT turn a broad trend directly into a generic business idea. The chain must be: SIGNAL -> SPECIFIC HUMAN PROBLEM -> EXISTING PRODUCTS -> VERIFIED/OBSERVED CUSTOMER COMPLAINTS OR GAP -> POTENTIAL PRODUCT OPPORTUNITY -> TEST.

Rules:
- Start each opportunity with a specific human problem, not a product category.
- Only state a demand signal when the supplied data supports it. Name the signal/source in evidence.
- Never invent search volumes, growth percentages, product names, prices, review counts, customer complaints or market facts.
- Existing products should be actual products/product types supported by the supplied evidence where possible. If the supplied data is insufficient, say so rather than inventing brands.
- Customer gaps must be evidence-backed. If complaints/gaps are NOT present in the supplied data, set complaintsEvidence to an empty array and say "More product-review/comment evidence needed" in gap and unproven.
- Separate observed evidence from AI interpretation. Do not present interpretation as fact.
- A potential opportunity is not guaranteed demand.
- Do not use the old generic claim "limited options" unless the supplied evidence actually demonstrates it.
- Prefer narrow, high-intent consumer problems with an identifiable reason someone might pay to solve them.
- Score is directional, based ONLY on strength and breadth of supplied evidence, not a prediction. Use one of "High potential", "Medium-high", "Medium", "Needs evidence".
- confidence is an integer from 1-10 representing confidence in the evidence supporting the opportunity, NOT likelihood of success.
- evidence should be an array of 2-5 short factual observations. Each observation must have source and detail fields.
- complaintsEvidence should be an array of 0-4 short factual observations, each with source and detail. Never fabricate these.
- sources should contain up to 4 exact URLs from supplied data only.
- Return ONLY valid JSON with key opportunities. Each opportunity must have exactly these keys: category,title,problem,trend,score,confidence,evidence,products,complaintsEvidence,gap,unproven,audience,ads,sell,next,sources.

Data: ${compact}`;

    const response = await client.chat.completions.create({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return evidence-led structured commercial research. Never fabricate sources, prices, demand or customer complaints.' },
        { role: 'user', content: prompt }
      ]
    });

    stage = 'processing OpenAI response';
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned an empty response');
    const parsed = JSON.parse(content);
    return res.status(200).json({ ...parsed, scannedAt: new Date().toISOString(), sourceCoverage: { googleTrends: trendItems.length, googleNews: sourceResults.reduce((n, x) => n + x.news.length, 0), youtube: sourceResults.reduce((n, x) => n + x.youtube.length, 0), youtubeEnabled: Boolean(process.env.YOUTUBE_API_KEY), model } });
  } catch (error) {
    console.error(`Live scan failed at ${stage}:`, error);
    const detail = error?.status === 401 ? 'OpenAI rejected the API key.' : error?.status === 429 ? 'OpenAI rate limit or billing limit reached.' : error?.message || 'Unknown error';
    return res.status(500).json({ message: `Live scan failed while ${stage}: ${detail}`, stage });
  }
};
