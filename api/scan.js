const OpenAI = require('openai');

const seedSignals = [
  { category: 'Automotive', signal: 'DIY car detailing and trim restoration', context: 'People want to restore faded, scratched or tired-looking vehicle plastics without replacing expensive trim.' },
  { category: 'Home & DIY', signal: 'Kitchen appliance storage and organisation', context: 'People want to hide everyday appliances and reclaim kitchen worktop space.' },
  { category: 'Pets', signal: 'At-home dog grooming and nail care', context: 'Owners want to groom dogs safely at home, especially when pets resist clippers or grinders.' },
  { category: 'Travel', signal: 'Family travel organisation', context: 'Parents want to reduce packing, airport and in-transit friction when travelling with children.' }
];

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ message: 'GET only' });
  if (!process.env.OPENAI_API_KEY) return res.status(200).json({ message: 'Add OPENAI_API_KEY in the deployment environment to enable live AI discovery.', opportunities: [] });
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `You are a product opportunity discovery analyst. Turn these early signals into 4 concise opportunity hypotheses, one per category. Do NOT claim these are proven trends; treat them as hypotheses. Return ONLY valid JSON with key opportunities, an array of objects with exactly these keys: category,title,trend,score,evidence,products,gap,audience,ads,sell,next. score must be one of "High potential", "Medium-high", "Medium", "Needs evidence" and must be directional rather than a forecast. ads and sell should use " • " separators. Signals: ${JSON.stringify(seedSignals)}`;
    const response = await client.chat.completions.create({ model: 'gpt-4o-mini', temperature: 0.3, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Return structured commercial research only.' }, { role: 'user', content: prompt }] });
    const parsed = JSON.parse(response.choices[0].message.content);
    return res.status(200).json(parsed);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Live scan failed. Check the OpenAI API configuration.' });
  }
};
