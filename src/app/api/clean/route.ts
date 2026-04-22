import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from "@google/genai";
import { OpenAI } from "openai";
import { createSupabaseAdminClient } from '@/lib/supabase-admin';

const supabaseAdmin = createSupabaseAdminClient();
const CLEAN_CHUNK_SIZE = 10000;
const CLEAN_TITLE_PREFIX = 'CLEAN_TITLE|';
const USER_LIMIT_PREFIX = 'user_limit:';
const SECURITY_EVENT_PREFIX = 'security_event:';
const DEFAULT_USER_LIMITS = {
  maxUniqueIps: 3,
  maxCleanActionsPerHour: 60,
};

const splitTextSmartly = (text: string, maxLength: number = CLEAN_CHUNK_SIZE): string[] => {
  const lines = String(text || '').split('\n');
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    if ((current + line).length > maxLength && current.trim().length > 0) {
      chunks.push(current.trim());
      current = '';
    }
    current += line + '\n';
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }
  return chunks.length > 0 ? chunks : [String(text || '')];
};

const buildCleanPrompt = (chunk: string, index: number, total: number) => `
NHIỆM VỤ: Làm sạch đoạn transcript thô dưới đây.

YÊU CẦU BẮT BUỘC:
1. GIỮ NGUYÊN 100% CÂU TỪ GỐC: Tuyệt đối không được thay đổi văn phong, không thêm thắt nội dung, KHÔNG biến tấu thành truyện kể.
2. Chỉ xóa toàn bộ các mốc thời gian (timestamp) như 00:00, [12:34], v.v.
3. Chỉ sửa các lỗi chính tả hoặc lỗi nối câu phát sinh do việc ngắt dòng của timestamp gây ra để đảm bảo mạch văn tự nhiên.
4. Kết quả phải là văn bản liền mạch, không chia chương, không chia mục.
5. Đây là đoạn ${index + 1}/${total}. Chỉ xử lý đúng phần văn bản được cung cấp bên dưới.
6. Chỉ trả về nội dung đã làm sạch, không thêm lời dẫn.

Văn bản gốc:
${chunk}
`;

const extractTranscriptTitle = (rawText: string): string => {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  let title = lines[0];
  const transcriptIdx = lines.findIndex((line) => /^transcripts?\s*:/i.test(line));
  if (transcriptIdx > 0) {
    title = lines[0];
  }

  title = title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
  return title.slice(0, 180);
};

const normalizeTitleKey = (title: string) =>
  String(title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const getUserLimits = async (userId: string) => {
  const provider = `${USER_LIMIT_PREFIX}${userId}`;
  const { data: row } = await supabaseAdmin
    .from('api_vault')
    .select('api_key')
    .eq('provider', provider)
    .limit(1)
    .maybeSingle();

  let parsed: any = {};
  try {
    parsed = row?.api_key ? JSON.parse(String(row.api_key)) : {};
  } catch {
    parsed = {};
  }

  return {
    maxUniqueIps: Math.max(2, Number(parsed?.maxUniqueIps ?? DEFAULT_USER_LIMITS.maxUniqueIps)),
    maxCleanActionsPerHour: Math.max(
      1,
      Number(parsed?.maxCleanActionsPerHour ?? DEFAULT_USER_LIMITS.maxCleanActionsPerHour)
    ),
  };
};

const logSecurityEvent = async (args: {
  userId: string;
  userEmail: string;
  reason: 'TOO_MANY_IPS' | 'TOO_MANY_CLEAN_ACTIONS';
  detail: string;
  currentValue?: number;
  limitValue?: number;
}) => {
  const payload = {
    userId: args.userId,
    userEmail: args.userEmail,
    reason: args.reason,
    detail: args.detail,
    currentValue: args.currentValue ?? null,
    limitValue: args.limitValue ?? null,
    createdAt: new Date().toISOString(),
    resolved: false,
    resolvedAt: null,
  };

  await supabaseAdmin.from('api_vault').insert({
    provider: `${SECURITY_EVENT_PREFIX}${Date.now()}:${args.userId}`,
    api_key: JSON.stringify(payload),
  });
};

const cleanWithOpenAI = async (apiKey: string, text: string): Promise<string> => {
  const openai = new OpenAI({ apiKey: apiKey.trim() });
  const chunks = splitTextSmartly(text, CLEAN_CHUNK_SIZE);
  const outputs: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: buildCleanPrompt(chunks[i], i, chunks.length) }],
    });
    outputs.push((response.choices[0]?.message?.content || '').trim());
  }

  return outputs.join('\n\n').trim();
};

const cleanWithGemini = async (apiKey: string, text: string): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
  const chunks = splitTextSmartly(text, CLEAN_CHUNK_SIZE);
  const outputs: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: buildCleanPrompt(chunks[i], i, chunks.length),
    });
    outputs.push((response.text || '').trim());
  }

  return outputs.join('\n\n').trim();
};

export async function POST(req: NextRequest) {
  try {
    const { text, userId, sessionId, provider, confirmDuplicate } = await req.json();

    if (!text || !userId || !sessionId) {
      return NextResponse.json({ error: 'Thiếu thông tin xác thực hoặc văn bản.' }, { status: 400 });
    }

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || '127.0.0.1';
    const userAgent = req.headers.get('user-agent') || 'Unknown';

    // 1. Lấy thông tin Profile
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('email, status, current_session_id, role, api_keys')
      .eq('id', userId)
      .single();

    if (profileError || !profile) return NextResponse.json({ error: 'Tài khoản không tồn tại.' }, { status: 404 });

    // 2. Bảo mật
    if (profile.status === 'pending') return NextResponse.json({ error: 'Tài khoản đang chờ duyệt.' }, { status: 403 });
    if (profile.status === 'blocked') return NextResponse.json({ error: 'Tài khoản bị chặn vì lý do bảo mật.' }, { status: 403 });
    if (profile.current_session_id !== sessionId) return NextResponse.json({ error: 'Phiên làm việc hết hạn.' }, { status: 401 });

    const limits = await getUserLimits(userId);
    const title = extractTranscriptTitle(text);
    const normalizedTitle = normalizeTitleKey(title);
    if (normalizedTitle) {
      const marker = `${CLEAN_TITLE_PREFIX}${normalizedTitle}`;
      const { data: duplicateRow } = await supabaseAdmin
        .from('usage_logs')
        .select('user_email, created_at')
        .eq('tool_name', marker)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (duplicateRow && !confirmDuplicate) {
        return NextResponse.json(
          {
            error: 'Tiêu đề đã tồn tại trong hệ thống.',
            duplicate: {
              title,
              userEmail: duplicateRow.user_email,
              createdAt: duplicateRow.created_at,
            },
          },
          { status: 409 }
        );
      }
    }

  // 3. Log IP & Check Auto-block
    const { data: sameIpLog } = await supabaseAdmin
      .from('login_history')
      .select('id')
      .eq('user_id', userId)
      .eq('ip_address', ip)
      .limit(1)
      .maybeSingle();

    if (!sameIpLog) {
      await supabaseAdmin.from('login_history').insert({ user_id: userId, ip_address: ip, user_agent: userAgent });
      const { data: recentIps } = await supabaseAdmin
        .from('login_history')
        .select('ip_address')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      const uniqueIps = new Set((recentIps || []).map((l: any) => String(l.ip_address || '')));
      if (uniqueIps.size > limits.maxUniqueIps && profile.role !== 'admin') {
        await logSecurityEvent({
          userId,
          userEmail: String(profile.email || ''),
          reason: 'TOO_MANY_IPS',
          detail: `Đăng nhập từ quá nhiều IP trong thời gian ngắn`,
          currentValue: uniqueIps.size,
          limitValue: limits.maxUniqueIps,
        });
        await supabaseAdmin.from('profiles').update({ status: 'blocked' }).eq('id', userId);
        return NextResponse.json({ error: 'Tài khoản bị chặn vì lý do bảo mật' }, { status: 403 });
      }
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: cleanCount, error: cleanCountError } = await supabaseAdmin
      .from('cleaning_history')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', oneHourAgo);
    if (cleanCountError) {
      return NextResponse.json({ error: cleanCountError.message }, { status: 500 });
    }

    const recentCleanActions = Number(cleanCount || 0);
    if (recentCleanActions >= limits.maxCleanActionsPerHour && profile.role !== 'admin') {
      await logSecurityEvent({
        userId,
        userEmail: String(profile.email || ''),
        reason: 'TOO_MANY_CLEAN_ACTIONS',
        detail: 'Vượt giới hạn thao tác làm sạch trong 1 giờ',
        currentValue: recentCleanActions,
        limitValue: limits.maxCleanActionsPerHour,
      });
      await supabaseAdmin.from('profiles').update({ status: 'blocked' }).eq('id', userId);
      return NextResponse.json(
        { error: 'Tài khoản bị chặn tạm thời do thao tác quá nhiều. Vui lòng liên hệ quản trị viên.' },
        { status: 403 }
      );
    }

    // 4. Xử lý AI & Lấy Key từ Kho Khóa Tổng (api_vault) nếu cần
    let cleanedText = "";
    const apiKeys = profile.api_keys || {};
    let finalKey = "";

    if (provider === 'openai') {
      finalKey = apiKeys.openai || "";
      if (!finalKey) {
        // Thử lấy từ Kho Khóa Tổng
        const { data: vault } = await supabaseAdmin.from('api_vault').select('api_key').eq('provider', 'openai').single();
        finalKey = vault?.api_key || "";
      }
      if (!finalKey) return NextResponse.json({ error: 'Chưa có API Key ChatGPT.' }, { status: 403 });

      cleanedText = await cleanWithOpenAI(finalKey, text);
    } else {
      finalKey = apiKeys.gemini || "";
      if (!finalKey) {
        const { data: vault } = await supabaseAdmin.from('api_vault').select('api_key').eq('provider', 'gemini').single();
        finalKey = vault?.api_key || "";
      }
      if (!finalKey) return NextResponse.json({ error: 'Chưa có API Key Gemini.' }, { status: 403 });

      cleanedText = await cleanWithGemini(finalKey, text);
    }

    // 5. CẬP NHẬT GIÁM SÁT & GHI LỊCH SỬ THỜI GIAN THỰC
    const cleanedOutput = cleanedText.trim();
    await Promise.all([
      supabaseAdmin
        .from('profiles')
        .update({
          last_active_at: new Date().toISOString(),
          current_ip: ip
        })
        .eq('id', userId),
      supabaseAdmin.from('cleaning_history').insert({
        user_id: userId,
        user_email: profile.email,
        input_content: text,
        output_content: cleanedOutput,
        provider: provider,
        char_count: text.length,
        ip_address: ip
      }),
      supabaseAdmin.from('usage_logs').insert({
        user_id: userId,
        user_email: profile.email,
        char_count: text.length,
        tool_name: `Làm sạch (${provider})`
      }),
      normalizedTitle
        ? supabaseAdmin.from('usage_logs').insert({
            user_id: userId,
            user_email: profile.email,
            char_count: 0,
            tool_name: `${CLEAN_TITLE_PREFIX}${normalizedTitle}`,
          })
        : Promise.resolve({}),
    ]);

    return NextResponse.json({ result: cleanedOutput, title });

  } catch (error: any) {
    console.error('API Error:', error);
    return NextResponse.json({ error: 'Lỗi hệ thống AI', details: error.message }, { status: 500 });
  }
}
