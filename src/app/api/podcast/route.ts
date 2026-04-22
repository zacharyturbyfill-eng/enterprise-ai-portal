import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';
import { OpenAI } from 'openai';
import { createSupabaseAdminClient } from '@/lib/supabase-admin';

type PodcastRole = {
  id: string;
  name: string;
  roleType: 'Host' | 'Doctor' | 'Guest';
  selected: boolean;
  gender: 'Nam' | 'Nữ';
};

type DialogueLine = {
  speaker: string;
  text: string;
  roleType: 'Host' | 'Doctor' | 'Guest';
};

const supabaseAdmin = createSupabaseAdminClient();

const chunkText = (text: string, maxLength: number = 2500): string[] => {
  const paragraphs = text.split(/\n+/);
  const chunks: string[] = [];
  let current = '';
  for (const para of paragraphs) {
    if ((current + para).length > maxLength && current.length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += para + '\n';
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dialogueCharCount = (lines: DialogueLine[]) =>
  lines.reduce((sum, line) => sum + String(line.text || '').length, 0);

const renderDialogueDraft = (lines: DialogueLine[]) =>
  lines.map((line) => `${line.speaker}: ${line.text}`).join('\n');

function mergeFragmentedLines(lines: DialogueLine[]): DialogueLine[] {
  const merged: DialogueLine[] = [];
  for (const line of lines) {
    if (merged.length === 0) {
      merged.push(line);
      continue;
    }
    const prev = merged[merged.length - 1];
    const prevText = String(prev.text || '').trim();
    const curText = String(line.text || '').trim();
    const prevLooksComplete = /[.!?…:;”"')\]]$/.test(prevText);
    const shouldMerge =
      prev.speaker === line.speaker &&
      (!prevLooksComplete || prevText.length < 55 || curText.length < 35);

    if (shouldMerge) {
      prev.text = `${prevText} ${curText}`.replace(/\s+/g, ' ').trim();
    } else {
      merged.push(line);
    }
  }
  return merged;
}

async function resolveProviderKey(profile: any, provider: 'gemini' | 'openai') {
  const apiKeys = profile.api_keys || {};
  if (provider === 'openai') {
    const direct = apiKeys.openai || '';
    if (direct) return direct;
    const { data: vault } = await supabaseAdmin
      .from('api_vault')
      .select('api_key')
      .eq('provider', 'openai')
      .single();
    return vault?.api_key || '';
  }

  const direct = apiKeys.gemini || '';
  if (direct) return direct;
  const { data: vault } = await supabaseAdmin
    .from('api_vault')
    .select('api_key')
    .eq('provider', 'gemini')
    .single();
  return vault?.api_key || '';
}

function cleanDialogueLines(lines: any[]): DialogueLine[] {
  const cleaned = lines
    .map((line) => ({
      speaker: String(line?.speaker || '').trim(),
      text: String(line?.text || '')
        .replace(/\r?\n|\r/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      roleType: line?.roleType === 'Doctor' || line?.roleType === 'Guest' ? line.roleType : 'Host',
    }))
    .filter((line) => line.speaker && line.text);
  return mergeFragmentedLines(cleaned);
}

async function generateWithGemini(
  key: string,
  prompt: string,
  systemInstruction: string
): Promise<DialogueLine[]> {
  const ai = new GoogleGenAI({ apiKey: key.trim() });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-lite',
    contents: prompt,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            speaker: { type: Type.STRING },
            text: { type: Type.STRING },
            roleType: { type: Type.STRING, enum: ['Host', 'Doctor', 'Guest'] },
          },
          required: ['speaker', 'text', 'roleType'],
        },
      },
    },
  });
  const raw = response.text || '[]';
  const parsed = JSON.parse(raw);
  const lines = Array.isArray(parsed) ? parsed : [];
  return cleanDialogueLines(lines);
}

async function generateWithOpenAI(
  key: string,
  prompt: string,
  systemInstruction: string
): Promise<DialogueLine[]> {
  const client = new OpenAI({ apiKey: key.trim() });
  const completion = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemInstruction },
      {
        role: 'user',
        content:
          `${prompt}\n\nReturn JSON exactly as: {"lines":[{"speaker":"...","text":"...","roleType":"Host|Doctor|Guest"}]}`,
      },
    ],
  });
  const raw = completion.choices[0]?.message?.content || '{"lines":[]}';
  const parsed = JSON.parse(raw);
  const lines = Array.isArray(parsed?.lines) ? parsed.lines : [];
  return cleanDialogueLines(lines);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const inputText = String(body?.text || '').trim();
    const title = String(body?.title || '').trim().slice(0, 180);
    const userId = String(body?.userId || '');
    const provider: 'gemini' | 'openai' = body?.provider === 'openai' ? 'openai' : 'gemini';
    const roles = Array.isArray(body?.roles) ? (body.roles as PodcastRole[]) : [];

    if (!inputText || !userId) {
      return NextResponse.json({ error: 'Thiếu nội dung hoặc userId.' }, { status: 400 });
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || '127.0.0.1';
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, status, api_keys')
      .eq('id', userId)
      .single();
    if (profileError || !profile) {
      return NextResponse.json({ error: 'Tài khoản không tồn tại.' }, { status: 404 });
    }
    if (profile.status !== 'approved') {
      return NextResponse.json({ error: 'Tài khoản chưa được duyệt.' }, { status: 403 });
    }

    const activeRoles = roles.filter((r) => r.selected);
    if (activeRoles.length === 0) {
      return NextResponse.json({ error: 'Cần ít nhất 1 nhân vật.' }, { status: 400 });
    }

    const key = await resolveProviderKey(profile, provider);
    if (!key) {
      return NextResponse.json(
        { error: provider === 'openai' ? 'Chưa cấu hình API key OpenAI.' : 'Chưa cấu hình API key Gemini.' },
        { status: 403 }
      );
    }

    const chunks = chunkText(inputText, 2500);
    const roleGuide = activeRoles
      .map((r) => {
        const roleLabel = r.roleType === 'Host' ? 'MC' : r.roleType === 'Doctor' ? 'Bác sĩ' : 'Khách mời';
        return `${roleLabel}: tên ${r.name}, giới tính ${r.gender}.`;
      })
      .join('\n');
    const isMonologue = activeRoles.length === 1;
    const firstRole = activeRoles[0];
    const systemInstruction = isMonologue
      ? `
Bạn là biên tập viên podcast chuyên nghiệp. Viết thành độc thoại tự nhiên.
Vai chính: ${firstRole.name}.
Yêu cầu:
1. Không nói "theo văn bản", "đoạn trên", "nội dung đã cho".
2. Xem nội dung là kiến thức/câu chuyện của chính người nói.
3. Giữ đúng ngôn ngữ của đầu vào.
4. Chào mở đầu một lần duy nhất ở chunk đầu; không lặp lại ở các chunk sau.
`
      : `
Bạn là biên kịch podcast chuyên nghiệp. Viết thành hội thoại tự nhiên nhiều nhân vật.
Danh sách nhân vật:
${roleGuide}
Yêu cầu:
1. Không nói "theo văn bản", "đoạn trên", "nội dung đã cho".
2. Tự kể lại sao cho người nghe không cần xem văn bản gốc.
3. Giữ đúng ngôn ngữ của đầu vào.
4. Chào mở đầu một lần duy nhất ở chunk đầu; không lặp lại ở các chunk sau.
5. Giới tính chỉ để hiểu ngữ cảnh nhân vật, không ép buộc mẫu xưng hô cứng.
6. Trong mọi tình huống, MC luôn xưng tên của mình khi nói và mở câu với "thưa bác sĩ" khi trao đổi chuyên môn.
7. Bác sĩ luôn gọi tên MC và luôn xưng "tôi" khi nói với MC hoặc với bác sĩ khác (nếu có), không đổi ngôi thất thường.
`;

    const finalLines: DialogueLine[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isFirst = i === 0;
      const isLast = i === chunks.length - 1;
      const prompt = `
Nội dung nguồn:
"""${chunk}"""

Ràng buộc:
- ${isFirst ? 'Bắt đầu tự nhiên (chào mở đầu ngắn gọn).' : 'Không được chào lại hoặc giới thiệu lại chương trình.'}
- ${isLast ? 'Kết thúc bằng một đoạn tổng kết ngắn.' : 'Kết thúc mở để nối mạch sang phần tiếp theo.'}
- Không được lược bỏ ý quan trọng. Mỗi luận điểm/diễn biến/chỉ dẫn chính trong chunk nguồn phải được thể hiện lại trong hội thoại.
- Giữ trọn vẹn mạch logic: nguyên nhân -> diễn biến -> kết luận (nếu có).
- Không tóm tắt quá ngắn; ưu tiên đầy đủ ý hơn là viết gọn.
- Mỗi lượt thoại phải là câu/đoạn hoàn chỉnh, tránh tách vụn một ý thành nhiều dòng liên tiếp cùng một người nói.
- Chuyển thể tự nhiên, KHÔNG bê nguyên văn từng câu từ nguồn gốc.
`;

      let lines: DialogueLine[] = [];
      let lastError = '';
      const minChunkChars = Math.max(450, Math.floor(chunk.length * (isMonologue ? 0.82 : 0.72)));
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          lines =
            provider === 'openai'
              ? await generateWithOpenAI(key, prompt, systemInstruction)
              : await generateWithGemini(key, prompt, systemInstruction);
          if (lines.length > 0 && dialogueCharCount(lines) >= minChunkChars) break;
          if (lines.length > 0 && attempt < 4) {
            // Có output nhưng còn ngắn: thử lại để phủ đủ ý hơn.
            await wait(900 * attempt);
          }
        } catch (e: any) {
          lastError = e?.message || 'AI generation failed';
          if (attempt < 4) await wait(1200 * attempt);
        }
      }
      if (lines.length === 0) {
        return NextResponse.json({ error: `Không tạo được kịch bản ở phần ${i + 1}. ${lastError}` }, { status: 500 });
      }

      // Pass mở rộng có kiểm soát nếu chunk vẫn bị co quá mức.
      if (dialogueCharCount(lines) < minChunkChars) {
        const expandPrompt = `
Nguồn gốc:
"""${chunk}"""

Bản chuyển thể hiện tại:
"""${renderDialogueDraft(lines)}"""

Hãy viết lại bản hội thoại đầy đủ ý hơn:
- Giữ nguyên nhân vật và phong cách.
- Không bỏ chi tiết quan trọng từ nguồn.
- Không tóm tắt quá ngắn.
- Mỗi lượt thoại cần liền mạch, không chia vụn một câu thành nhiều dòng cùng speaker.
- Không bê nguyên văn nguồn; diễn đạt lại theo lối hội thoại tự nhiên.
- Tổng độ dài phần text hội thoại tối thiểu khoảng ${minChunkChars} ký tự.
`;
        try {
          const expanded =
            provider === 'openai'
              ? await generateWithOpenAI(key, expandPrompt, systemInstruction)
              : await generateWithGemini(key, expandPrompt, systemInstruction);
          if (dialogueCharCount(expanded) > dialogueCharCount(lines)) {
            lines = expanded;
          }
        } catch {
          // Giữ output cũ nếu pass mở rộng lỗi.
        }
      }

      finalLines.push(...lines);
      await wait(350);
    }

    const { data: historyRow, error: historyError } = await supabaseAdmin
      .from('prompt_history')
      .insert({
        user_id: userId,
        user_email: profile.email,
        input_transcript: inputText,
        results: finalLines,
        genre: title ? `Podcast: ${title}` : 'Podcast',
        style: 'podcast',
        nationality: 'auto',
        provider,
        ip_address: ip,
      })
      .select('*')
      .single();
    if (historyError) {
      return NextResponse.json({ error: `Lỗi lưu lịch sử podcast: ${historyError.message}` }, { status: 500 });
    }

    await supabaseAdmin.from('usage_logs').insert({
      user_id: userId,
      user_email: profile.email,
      tool_name: title ? `Tạo kịch bản Podcast (${provider}) | ${title}` : `Tạo kịch bản Podcast (${provider})`,
      char_count: inputText.length,
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
      history: historyRow,
      results: finalLines,
      provider,
      model: provider === 'openai' ? 'gpt-4.1-mini' : 'gemini-2.5-flash-lite',
      title,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Podcast API error' }, { status: 500 });
  }
}
