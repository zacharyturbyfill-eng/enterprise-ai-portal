import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { OpenAI } from 'openai';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';

const supabaseAdmin = createSupabaseAdminClient();
type ModelProvider = 'gemini' | 'openai';

type SeoPackage = {
  title: string;
  description: string;
  timestamps: string[];
  hashtags: string[];
  keywords: string[];
};
type SeoLanguage = 'vi' | 'ja' | 'ko' | 'en';

const STOPWORDS = new Set([
  'va', 'và', 'la', 'là', 'cua', 'của', 'cho', 'trong', 'nhung', 'những', 'mot', 'một', 'cac', 'các',
  'voi', 'với', 'khi', 'sau', 'truoc', 'trước', 'duoc', 'được', 'the', 'thể', 'nay', 'này', 'do', 'đó',
  'co', 'có', 'khong', 'không', 'se', 'sẽ', 'den', 'đến', 'tu', 'từ', 'tren', 'trên', 'noi', 'nội', 'dung',
  'youtube', 'video', 'transcripts', 'transcript'
]);

function parseToSeconds(raw: string): number | null {
  const hhmmss = raw.match(/(\d{2}):(\d{2}):(\d{2})/);
  if (hhmmss) return Number(hhmmss[1]) * 3600 + Number(hhmmss[2]) * 60 + Number(hhmmss[3]);
  const mmss = raw.match(/(\d{2}):(\d{2})/);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  return null;
}

function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`
    : `${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
}

function extractDurationSeconds(transcript: string): number {
  const matches = transcript.match(/\d{2}:\d{2}(?::\d{2})?/g) || [];
  let maxSec = 0;
  for (const match of matches) {
    const sec = parseToSeconds(match);
    if (sec && sec > maxSec) maxSec = sec;
  }
  return Math.max(maxSec, 600);
}

function extractTitle(transcript: string): string {
  const lines = transcript.replace(/\r\n/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
  const found = lines.find((line) => {
    const lower = line.toLowerCase();
    if (lower === 'transcripts:' || lower === 'transcript:') return false;
    if (/^\(?\d{2}:\d{2}/.test(line)) return false;
    return line.length > 10;
  });
  return (found || 'Mô tả video YouTube chuẩn SEO').slice(0, 180);
}

function extractTopTokens(transcript: string, max = 30): string[] {
  const raw = transcript
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const count = new Map<string, number>();
  for (const token of raw) count.set(token, (count.get(token) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, max);
}

function toHashtag(word: string): string {
  return `#${word.replace(/\s+/g, '')}`;
}

function detectSeoLanguage(transcript: string): SeoLanguage {
  const text = String(transcript || '');
  if (/[ぁ-んァ-ン一-龯々〆〤]/u.test(text)) return 'ja';
  if (/[가-힣]/u.test(text)) return 'ko';
  if (/[ăâđêôơưĂÂĐÊÔƠƯáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/u.test(text)) return 'vi';
  return 'en';
}

function languageName(lang: SeoLanguage): string {
  if (lang === 'ja') return 'Japanese';
  if (lang === 'ko') return 'Korean';
  if (lang === 'vi') return 'Vietnamese';
  return 'English';
}

function buildFallbackTimestamps(transcript: string): string[] {
  const duration = extractDurationSeconds(transcript);
  const out: string[] = [];
  for (let i = 0; i < 10; i++) {
    const sec = Math.floor((duration * i) / 9);
    out.push(`${formatTimestamp(sec)} - Mốc nội dung chính ${i + 1}`);
  }
  return out;
}

function buildFallbackDescription(transcript: string, title: string): string {
  const plain = transcript.replace(/\r\n/g, '\n').replace(/\n+/g, ' ').trim();
  const excerpt = plain.slice(0, 700);
  return [
    `Chào mừng quý vị quay trở lại kênh. Trong video "${title}", chúng ta sẽ cùng đi qua các nội dung nổi bật một cách dễ hiểu và thực tế.`,
    `Nội dung chính bám sát transcript gốc: ${excerpt}${plain.length > 700 ? '...' : ''}`,
    'Mời quý vị theo dõi phần mốc thời gian chi tiết bên dưới để xem nhanh từng chủ đề quan trọng.',
  ].join('\n\n');
}

function normalizeSeoPackage(input: any, transcript: string): SeoPackage {
  const topTokens = extractTopTokens(transcript, 40);
  const timestamps = Array.isArray(input?.timestamps) ? input.timestamps : [];
  const hashtags = Array.isArray(input?.hashtags) ? input.hashtags : [];
  const keywords = Array.isArray(input?.keywords) ? input.keywords : [];
  const normalizedTimestamps = timestamps.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 10);
  const normalizedHashtags = hashtags
    .map((h: any) => String(h).trim().replace(/\s+/g, ''))
    .filter(Boolean)
    .map((h: string) => (h.startsWith('#') ? h : `#${h}`));
  const normalizedKeywords = keywords.map((k: any) => String(k).trim()).filter(Boolean);

  while (normalizedHashtags.length < 20 && topTokens.length > normalizedHashtags.length) {
    normalizedHashtags.push(toHashtag(topTokens[normalizedHashtags.length]));
  }
  while (normalizedKeywords.length < 20 && topTokens.length > normalizedKeywords.length) {
    normalizedKeywords.push(topTokens[normalizedKeywords.length]);
  }
  while (normalizedHashtags.length < 20) normalizedHashtags.push(`#seo${normalizedHashtags.length + 1}`);
  while (normalizedKeywords.length < 20) normalizedKeywords.push(`tu-khoa-${normalizedKeywords.length + 1}`);

  const title = String(input?.title || extractTitle(transcript)).trim().slice(0, 200);
  const description = String(input?.description || '').trim() || buildFallbackDescription(transcript, title);

  return {
    title,
    description,
    timestamps: (normalizedTimestamps.length > 0 ? normalizedTimestamps : buildFallbackTimestamps(transcript)).slice(0, 10),
    hashtags: normalizedHashtags.slice(0, 20),
    keywords: normalizedKeywords.slice(0, 20),
  };
}

async function generateSeoByProvider(
  provider: ModelProvider,
  apiKey: string,
  transcript: string
): Promise<SeoPackage> {
  const prompt = `Bạn là chuyên gia SEO YouTube tiếng Việt.
Nhiệm vụ: từ transcript sau, tạo mô tả video YouTube chuẩn SEO và trả về JSON đúng schema:
{
  "title": "string",
  "description": "mở đầu hấp dẫn + 2-3 đoạn mô tả rõ nội dung, phong cách tự nhiên, không bịa dữ kiện ngoài transcript",
  "timestamps": ["... đúng 10 mốc từ đầu đến cuối, định dạng 00:00 - mô tả ngắn ..."],
  "hashtags": ["... đúng 20 hashtag ..."],
  "keywords": ["... đúng 20 từ khóa SEO ..."]
}

Yêu cầu bắt buộc:
1) Description phải dùng được ngay cho phần mô tả video YouTube.
2) timestamps đúng 10 mốc, phân bố từ đầu đến cuối video.
3) hashtags đúng 20 mục, mỗi hashtag bắt đầu bằng #.
4) keywords đúng 20 mục, đa dạng, liên quan nội dung.
5) Không thêm giải thích ngoài JSON.

Transcript:
${transcript.slice(0, 120000)}`;

  if (provider === 'openai') {
    const client = new OpenAI({ apiKey: apiKey.trim() });
    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = completion.choices[0]?.message?.content || '{}';
    return normalizeSeoPackage(JSON.parse(raw), transcript);
  }

  const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-lite',
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          description: { type: Type.STRING },
          timestamps: { type: Type.ARRAY, items: { type: Type.STRING } },
          hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
          keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['title', 'description', 'timestamps', 'hashtags', 'keywords'],
      },
    },
  });
  const raw = response.text || '{}';
  return normalizeSeoPackage(JSON.parse(raw), transcript);
}

async function translateSeoPackageByProvider(
  provider: ModelProvider,
  apiKey: string,
  source: SeoPackage,
  targetLang: SeoLanguage
): Promise<SeoPackage> {
  const targetLanguage = languageName(targetLang);
  const prompt = `Translate the following YouTube SEO package into ${targetLanguage}.

Rules:
1) Keep JSON structure exactly: title, description, timestamps, hashtags, keywords.
2) Keep item counts exactly:
   - timestamps: 10
   - hashtags: 20
   - keywords: 20
3) Keep timestamp time values unchanged (e.g. "00:00 - ..."), only translate text descriptions.
4) Return JSON only.

Input JSON:
${JSON.stringify(source)}`;

  if (provider === 'openai') {
    const client = new OpenAI({ apiKey: apiKey.trim() });
    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = completion.choices[0]?.message?.content || '{}';
    return normalizeSeoPackage(JSON.parse(raw), source.description || source.title || '');
  }

  const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-lite',
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          description: { type: Type.STRING },
          timestamps: { type: Type.ARRAY, items: { type: Type.STRING } },
          hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
          keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['title', 'description', 'timestamps', 'hashtags', 'keywords'],
      },
    },
  });
  const raw = response.text || '{}';
  return normalizeSeoPackage(JSON.parse(raw), source.description || source.title || '');
}

const getSystemInstruction = (settings: any) => {
  return `Bạn là chuyên gia viết prompt cho video Veo 3. 
  
  TUÂN THỦ TUYỆT ĐỐI CÁC THIẾT LẬP SAU CHO MỌI PROMPT:
  - QUỐC GIA: ${settings.country}. Mọi chi tiết về con người, trang phục, kiến trúc, đồ vật, bối cảnh PHẢI mang đậm nét đặc trưng của quốc gia này. KHÔNG ĐƯỢC PHÉP pha trộn yếu tố của quốc gia khác (ví dụ: nếu là Nhật Bản, không được có yếu tố Việt Nam).
  - PHONG CÁCH: ${settings.style}. Mọi prompt phải tuân thủ nghiêm ngặt phong cách đồ họa này.
  - THỂ LOẠI: ${settings.category}. Nội dung phải phù hợp với thể loại này.
  
  QUY TẮC QUAN TRỌNG:
  1. TẢ THỰC (LITERAL): Lời thoại nói về cái gì, hãy hiện ra cái đó. Không dùng hình ảnh trừu tượng hay ẩn dụ.
  2. KHÔNG HIỆN NGƯỜI NÓI: Tuyệt đối không mô tả bác sĩ, người dẫn chương trình hay studio. Chỉ mô tả cảnh vật, đồ vật liên quan đến nội dung.
  3. CÂU LỆNH ĐƠN GIẢN: Mô tả rõ ràng "Cảnh quay cận cảnh (close-up) vào...", "Góc máy từ trên xuống (top-down) thấy...", "Máy quay đi chậm qua...".
  4. ÁNH SÁNG TỰ NHIÊN: Phù hợp với phong cách đã chọn.
  5. KHÔNG CHỮ: Không bao giờ có chữ viết trong video.
  6. KHÔNG DÙNG TRANSCRIPT: Tuyệt đối không đưa nội dung lời thoại (transcript) vào prompt. Chỉ mô tả hình ảnh.
  
  Mục tiêu: Người xem nhìn vào video phải thấy ngay sự liên quan trực tiếp đến câu nói và bối cảnh quốc gia/phong cách đã chọn.`;
};

async function getProviderKeyForUser(userId: string, provider: ModelProvider) {
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, status, api_keys')
    .eq('id', userId)
    .single();
  if (error || !profile) return { error: 'Tài khoản không tồn tại.', profile: null as any, key: '' };
  if (profile.status !== 'approved') return { error: 'Tài khoản chưa được duyệt.', profile, key: '' };

  const apiKeys = profile.api_keys || {};
  let key = provider === 'openai' ? apiKeys.openai || '' : apiKeys.gemini || '';
  if (!key) {
    const { data: vault } = await supabaseAdmin
      .from('api_vault')
      .select('api_key')
      .eq('provider', provider)
      .single();
    key = vault?.api_key || '';
  }
  if (!key) {
    return {
      error: provider === 'openai' ? 'Chưa cấu hình API key OpenAI.' : 'Chưa cấu hình API key Gemini.',
      profile,
      key: '',
    };
  }

  return { error: '', profile, key };
}

async function generatePromptsBatch(
  provider: ModelProvider,
  apiKey: string,
  segments: Array<{ index: number; relevantContext: string }>,
  localContext: string,
  settings: any,
  retryCount = 0
) {
  const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
  const segmentsData = segments.map((s) => ({ id: s.index, text: s.relevantContext }));

  const userPrompt = `
  CHỦ ĐỀ CHUNG: ${localContext}
  NHIỆM VỤ: Tạo prompt mô tả hình ảnh CHUYÊN NGHIỆP cho các đoạn sau.
  
  YÊU CẦU BẮT BUỘC (PHẢI CÓ TRONG MỌI PROMPT):
  - Bối cảnh (Setting): Phải mô tả rõ ràng bối cảnh mang đậm nét đặc trưng của quốc gia ${settings.country}.
  - Phong cách (Style): Phải đúng với phong cách ${settings.style}.
  - Thể loại (Category): Phải đúng với thể loại ${settings.category}.
  - Ánh sáng (Lighting): Phù hợp với phong cách ${settings.style}.
  - Chủ thể (Subject): Mô tả chi tiết đối tượng chính.
  - Góc máy (Camera Angle): Mô tả góc máy.
  - Nhân vật (Characters): Nếu có, mô tả ngoại hình, hành động phù hợp với quốc gia ${settings.country}.
  
  LƯU Ý QUAN TRỌNG: 
  1. TRONG MỖI PROMPT, BẮT BUỘC phải nhắc đến các từ khóa hoặc chi tiết mô tả đặc trưng của quốc gia ${settings.country} và phong cách ${settings.style}.
  2. TUYỆT ĐỐI KHÔNG ĐƯỢC ĐƯA NỘI DUNG LỜI THOẠI (TRANSCRIPT) VÀO PROMPT. Chỉ mô tả hình ảnh.
  3. KHÔNG ĐƯỢC PHÉP sử dụng các từ khóa mặc định như "Realistic", "Vietnamese" nếu không được yêu cầu. Chỉ sử dụng đúng giá trị được thiết lập: Quốc gia=${settings.country}, Phong cách=${settings.style}.
  
  DỮ LIỆU CẦN TẠO PROMPT: ${JSON.stringify(segmentsData)}
  
  Trả về JSON { "results": [{ "segmentIndex": số, "prompt": "mô tả tiếng Anh chuyên nghiệp" }] }.`;

  try {
    if (provider === 'gemini') {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: [{ parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: getSystemInstruction(settings),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              results: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    segmentIndex: { type: Type.INTEGER },
                    prompt: { type: Type.STRING },
                  },
                  required: ['segmentIndex', 'prompt'],
                },
              },
            },
            required: ['results'],
          },
        },
      });
      const text = response.text || '{"results":[]}';
      const json = JSON.parse(text);
      return json.results || [];
    }

    const client = new OpenAI({ apiKey: apiKey.trim() });
    const completion = await client.chat.completions.create({
      model: 'gpt-4.1-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: getSystemInstruction(settings) },
        {
          role: 'user',
          content:
            `${userPrompt}\n\nTrả về JSON đúng format: {"results":[{"segmentIndex":1,"prompt":"..."}]}`,
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content || '{"results":[]}';
    const json = JSON.parse(raw);
    return Array.isArray(json?.results) ? json.results : [];
  } catch (error: any) {
    if ((error.status === 500 || error.message?.includes('500')) && retryCount < 2) {
      await new Promise((r) => setTimeout(r, 1000));
      return generatePromptsBatch(provider, apiKey, segments, localContext, settings, retryCount + 1);
    }
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body?.action || '');
    const userId = String(body?.userId || '');
    const provider: ModelProvider = body?.provider === 'openai' ? 'openai' : 'gemini';
    if (!userId) return NextResponse.json({ error: 'Thiếu userId.' }, { status: 400 });

    const { error, profile, key } = await getProviderKeyForUser(userId, provider);
    if (error) return NextResponse.json({ error }, { status: 403 });

    if (action === 'generate_batch') {
      const segments = Array.isArray(body?.segments) ? body.segments : [];
      const settings = body?.settings || {};
      const localContext = String(body?.localContext || '');
      const results = await generatePromptsBatch(provider, key, segments, localContext, settings);
      return NextResponse.json({ success: true, results });
    }

    if (action === 'generate_seo') {
      const transcript = String(body?.transcript || '');
      if (!transcript.trim()) {
        return NextResponse.json({ error: 'Thiếu transcript để tạo SEO.' }, { status: 400 });
      }
      const seo = await generateSeoByProvider(provider, key, transcript);
      return NextResponse.json({ success: true, seo, lang: detectSeoLanguage(transcript) });
    }

    if (action === 'translate_seo') {
      const sourceSeo = body?.seo as SeoPackage;
      const targetLang = String(body?.targetLang || 'vi') as SeoLanguage;
      if (!sourceSeo || !sourceSeo.title || !Array.isArray(sourceSeo.timestamps)) {
        return NextResponse.json({ error: 'Thiếu dữ liệu SEO để dịch.' }, { status: 400 });
      }
      if (!['vi', 'ja', 'ko', 'en'].includes(targetLang)) {
        return NextResponse.json({ error: 'Ngôn ngữ dịch không hợp lệ.' }, { status: 400 });
      }
      const translated = await translateSeoPackageByProvider(provider, key, sourceSeo, targetLang);
      return NextResponse.json({ success: true, seo: translated, lang: targetLang });
    }

    if (action === 'save_history') {
      const transcript = String(body?.transcript || '');
      const settings = body?.settings || {};
      const segments = Array.isArray(body?.segments) ? body.segments : [];
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || '127.0.0.1';

      const outputLines = segments
        .filter((s: any) => s?.generatedPrompt)
        .map((s: any) => `${s.index}. ${s.generatedPrompt}`);

      const { data, error: insertError } = await supabaseAdmin
        .from('prompt_history')
        .insert({
          user_id: userId,
          user_email: profile.email,
          input_transcript: transcript,
          results: segments,
          genre: settings.category || 'MEDICAL3',
          style: 'medical3',
          nationality: settings.country || 'VIETNAM',
          provider,
          ip_address: ip,
        })
        .select('*')
        .single();

      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }

      await supabaseAdmin.from('usage_logs').insert({
        user_id: userId,
        user_email: profile.email,
        tool_name: `Tạo Prompt Medical 3.0 (${provider})`,
        char_count: transcript.length,
      });

      await supabaseAdmin
        .from('profiles')
        .update({
          last_active_at: new Date().toISOString(),
          current_ip: ip,
        })
        .eq('id', userId);

      return NextResponse.json({
        success: true,
        history: data,
        output_preview: outputLines.slice(0, 10),
      });
    }

    return NextResponse.json({ error: 'Action không hợp lệ.' }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Medical3 API error' }, { status: 500 });
  }
}
