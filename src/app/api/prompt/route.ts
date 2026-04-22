import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI, Type } from "@google/genai";
import { OpenAI } from "openai";
import { createSupabaseAdminClient } from '@/lib/supabase-admin';

const supabaseAdmin = createSupabaseAdminClient();

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
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
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

function detectLanguageFromText(text: string): SeoLanguage {
  return detectSeoLanguage(text);
}

function packageLanguageScore(pkg: SeoPackage, target: SeoLanguage): number {
  const merged = `${pkg.title}\n${pkg.description}\n${pkg.timestamps.join('\n')}`;
  const detected = detectLanguageFromText(merged);
  return detected === target ? 1 : 0;
}

function localizedPhrases(lang: SeoLanguage) {
  if (lang === 'ja') {
    return {
      fallbackTitle: 'YouTube動画のSEO説明',
      fallbackIntro: 'チャンネルへようこそ。本動画では、重要ポイントを分かりやすく整理してお届けします。',
      fallbackBodyLead: '元のトランスクリプトに基づく要点:',
      fallbackOutro: '下のタイムスタンプから、見たいテーマにすぐ移動できます。',
      tsLabel: '主要トピック',
    };
  }
  if (lang === 'ko') {
    return {
      fallbackTitle: '유튜브 SEO 영상 설명',
      fallbackIntro: '채널에 오신 것을 환영합니다. 이번 영상의 핵심 내용을 이해하기 쉽게 정리했습니다.',
      fallbackBodyLead: '원문 트랜스크립트 기반 핵심 내용:',
      fallbackOutro: '아래 타임스탬프에서 원하는 구간을 바로 확인하세요.',
      tsLabel: '주요 내용',
    };
  }
  if (lang === 'en') {
    return {
      fallbackTitle: 'SEO YouTube Video Description',
      fallbackIntro: 'Welcome back to the channel. In this video, we break down the key points in a clear and practical way.',
      fallbackBodyLead: 'Key points based on the original transcript:',
      fallbackOutro: 'Use the timestamps below to jump to each section quickly.',
      tsLabel: 'Key topic',
    };
  }
  return {
    fallbackTitle: 'Mô tả video YouTube chuẩn SEO',
    fallbackIntro: 'Chào mừng quý vị quay trở lại kênh. Video này tổng hợp các điểm quan trọng theo cách dễ theo dõi.',
    fallbackBodyLead: 'Nội dung chính bám sát transcript gốc:',
    fallbackOutro: 'Mời quý vị xem các mốc thời gian bên dưới để theo dõi nhanh từng phần.',
    tsLabel: 'Mốc nội dung chính',
  };
}

function buildFallbackTimestamps(transcript: string, lang: SeoLanguage): string[] {
  const duration = extractDurationSeconds(transcript);
  const i18n = localizedPhrases(lang);
  const out: string[] = [];
  for (let i = 0; i < 10; i++) {
    const sec = Math.floor((duration * i) / 9);
    out.push(`${formatTimestamp(sec)} - ${i18n.tsLabel} ${i + 1}`);
  }
  return out;
}

function buildFallbackDescription(transcript: string, title: string, lang: SeoLanguage): string {
  const i18n = localizedPhrases(lang);
  const plain = transcript.replace(/\r\n/g, '\n').replace(/\n+/g, ' ').trim();
  const excerpt = plain.slice(0, 700);
  return [
    `${i18n.fallbackIntro} "${title}".`,
    `${i18n.fallbackBodyLead} ${excerpt}${plain.length > 700 ? '...' : ''}`,
    i18n.fallbackOutro,
  ].join('\n\n');
}

function normalizeSeoPackage(input: any, transcript: string, lang: SeoLanguage): SeoPackage {
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

  const i18n = localizedPhrases(lang);
  const title = String(input?.title || extractTitle(transcript) || i18n.fallbackTitle).trim().slice(0, 200);
  const description = String(input?.description || '').trim() || buildFallbackDescription(transcript, title, lang);

  return {
    title,
    description,
    timestamps: (normalizedTimestamps.length > 0 ? normalizedTimestamps : buildFallbackTimestamps(transcript, lang)).slice(0, 10),
    hashtags: normalizedHashtags.slice(0, 20),
    keywords: normalizedKeywords.slice(0, 20),
  };
}

async function generateSeoByProvider(provider: 'gemini' | 'openai', apiKey: string, transcript: string, lang: SeoLanguage): Promise<SeoPackage> {
  const targetLanguage = languageName(lang);
  const prompt = `You are a YouTube SEO specialist.
Task: from the transcript below, generate a production-ready YouTube SEO package and return strict JSON schema:
{
  "title": "string",
  "description": "engaging opening + 2-3 clear sections strictly based on transcript",
  "timestamps": ["... exactly 10 items from start to end, format 00:00 - short description ..."],
  "hashtags": ["... exactly 20 hashtags ..."],
  "keywords": ["... exactly 20 SEO keywords ..."]
}

Hard requirements:
1) Write ALL fields in exactly this language: ${targetLanguage}.
2) Do NOT translate to any other language.
3) Description must be directly usable in YouTube description.
4) timestamps must be exactly 10 and distributed from start to end.
5) hashtags must be exactly 20, each starts with #.
6) keywords must be exactly 20, diverse and relevant.
7) Return JSON only. No explanations.

Transcript:
${transcript.slice(0, 120000)}`;

  const correctLanguageIfNeeded = async (pkg: SeoPackage): Promise<SeoPackage> => {
    if (packageLanguageScore(pkg, lang) === 1) return pkg;
    const correctionPrompt = `Rewrite the following JSON fields into ${targetLanguage} ONLY.
Keep exact structure and counts:
- timestamps must stay 10
- hashtags must stay 20
- keywords must stay 20
Return JSON only with keys: title, description, timestamps, hashtags, keywords.
Input JSON:
${JSON.stringify(pkg)}`;

    if (provider === 'openai') {
      const openai = new OpenAI({ apiKey });
      const response = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: correctionPrompt }],
        response_format: { type: 'json_object' },
      });
      const raw = response.choices[0]?.message?.content || '{}';
      return normalizeSeoPackage(JSON.parse(raw), transcript, lang);
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [{ parts: [{ text: correctionPrompt }] }],
      config: { responseMimeType: 'application/json' },
    });
    const raw = response.text || '{}';
    return normalizeSeoPackage(JSON.parse(raw), transcript, lang);
  };

  if (provider === 'openai') {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });
    const raw = response.choices[0]?.message?.content || '{}';
    const pkg = normalizeSeoPackage(JSON.parse(raw), transcript, lang);
    return correctLanguageIfNeeded(pkg);
  }

  const ai = new GoogleGenAI({ apiKey });
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
  const pkg = normalizeSeoPackage(JSON.parse(raw), transcript, lang);
  return correctLanguageIfNeeded(pkg);
}

export async function POST(req: NextRequest) {
  try {
    const { segments, userId, genre, style, nationality, provider, isFinal, fullTranscript, allResults, action, transcript } = await req.json();

    if (!userId) return NextResponse.json({ error: 'Thiếu UserId' }, { status: 400 });

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || '127.0.0.1';
    const { data: profile } = await supabaseAdmin.from('profiles').select('*').eq('id', userId).single();
    if (!profile || profile.status !== 'approved') return NextResponse.json({ error: 'Truy cập bị từ chối' }, { status: 403 });

    // Lấy API Key
    const apiKeys = profile.api_keys || {};
    let finalKey = "";
    if (provider === 'openai') {
      finalKey = apiKeys.openai || (await supabaseAdmin.from('api_vault').select('api_key').eq('provider', 'openai').single()).data?.api_key;
    } else {
      finalKey = apiKeys.gemini || (await supabaseAdmin.from('api_vault').select('api_key').eq('provider', 'gemini').single()).data?.api_key;
    }
    if (!finalKey) return NextResponse.json({ error: 'Chưa cấu hình API Key' }, { status: 403 });

    if (action === 'generate_seo') {
      const sourceTranscript = String(transcript || fullTranscript || '');
      if (!sourceTranscript.trim()) {
        return NextResponse.json({ error: 'Thiếu transcript để tạo SEO.' }, { status: 400 });
      }
      const lang = detectSeoLanguage(sourceTranscript);
      const seo = await generateSeoByProvider(provider === 'openai' ? 'openai' : 'gemini', finalKey, sourceTranscript, lang);
      return NextResponse.json({ success: true, seo });
    }

    // CASE 1: Chỉ lưu lịch sử khi hoàn tất
    if (isFinal && fullTranscript && allResults) {
      await supabaseAdmin.from('prompt_history').insert({
        user_id: userId,
        user_email: profile.email,
        input_transcript: fullTranscript,
        results: allResults,
        genre: genre,
        style: style,
        nationality: nationality,
        provider: provider,
        ip_address: ip
      });

      await supabaseAdmin.from('usage_logs').insert({
        user_id: userId,
        user_email: profile.email,
        tool_name: `Hoàn tất Prompt Video (${style})`,
        char_count: (fullTranscript as string).length
      });

      return NextResponse.json({ success: true });
    }

    // CASE 2: Xử lý tạo prompt cho cụm segments hiện tại
    if (!segments || segments.length === 0) return NextResponse.json({ results: [] });

    const systemInstruction = `You are the "Veo3 Cinematic Masterpiece Engine," a world-class specialist in Prompt Engineering for Google's Veo AI.

GOAL: Convert transcripts into extremely hyper-detailed, photorealistic 8k video prompts.

CORE RULES for HIGH QUALITY:
1. BE VISUAL & DENSE: Each prompt must be 100-150 words. Describe everything: 
   - Lighting: Volumetric lighting, anamorphic flares, soft clinical glow, golden hour, or high-contrast studio setup.
   - Textures: Pores on skin, micro-scratches on surgical steel, steam rising, microscopic anatomical details.
   - Camera: Macro shots, 50mm cinematic lens, slow-motion pans, slider shots, extreme close-up, shallow depth of field.
2. MEDICAL ACCURACY & SAFETY: 
   - Focusing on clinical precision. 
   - AVOID BLOOD AND GORE: To prevent safety filter violations, describe surgical scenes as "clean clinical procedures," using metaphoric professional terminology or focusing on the technology/equipment. 
   - No graphic violence. Content must be professional and safe for a premium corporate/medical environment.
3. NO SPEAKERS/METAPHORS: Never describe the person speaking. Focus strictly on the literal visual subject of the text. No text overlays or watermarks.

NATIONALITY & CULTURE:
Ensure architecture, facial features, healthcare settings, and objects are authentic to ${nationality}.

OUTPUT: Return ONLY the structured JSON with detailed English descriptions.

Genre: ${genre} | Style: ${style} | Nationality: ${nationality}`;

    let results = [];

    if (provider === 'openai') {
      const openai = new OpenAI({ apiKey: finalKey });
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: `Segments: ${JSON.stringify(segments)}. Generate JSON { "results": [{"id": number, "prompt": "string"}] }` }
        ],
        response_format: { type: "json_object" }
      });
      const json = JSON.parse(response.choices[0].message?.content || '{"results":[]}');
      results = json.results || [];
    } else {
      const ai = new GoogleGenAI({ apiKey: finalKey });
      const model = ai.models.generateContent({
        model: "gemini-2.5-flash-lite",
        contents: [{ parts: [{ text: `Segments: ${JSON.stringify(segments)}. Generate prompts. Return JSON { "results": [{ "segmentIndex": number, "prompt": "string" }] }` }] }],
        config: {
          systemInstruction: systemInstruction,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              results: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    segmentIndex: { type: Type.INTEGER },
                    prompt: { type: Type.STRING }
                  },
                  required: ["segmentIndex", "prompt"]
                }
              }
            },
            required: ["results"]
          }
        }
      });
      const resText = (await model).text || '{"results":[]}';
      const json = JSON.parse(resText);
      results = json.results.map((r: any) => ({ id: r.segmentIndex, prompt: r.prompt }));
    }

    // Cập nhật hoạt động cuối
    await supabaseAdmin.from('profiles').update({ last_active_at: new Date().toISOString(), current_ip: ip }).eq('id', userId);

    return NextResponse.json({ results });

  } catch (error: any) {
    console.error('Prompt API Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
