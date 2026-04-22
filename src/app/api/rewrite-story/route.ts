import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { OpenAI } from "openai";
import { createSupabaseAdminClient } from "@/lib/supabase-admin";

const supabaseAdmin = createSupabaseAdminClient();
const CHUNK_TARGET = 2000;

type Provider = "gemini" | "openai";

const splitByParagraphs = (text: string, targetLength: number = CHUNK_TARGET): string[] => {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    if ((current.length + 2 + paragraph.length) <= targetLength) {
      current += `\n\n${paragraph}`;
      continue;
    }

    chunks.push(current);
    current = paragraph;
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [normalized];
};

const buildPrompt = (
  originalChunk: string,
  previousOutput: string,
  renameCharacters: boolean,
  chunkIndex: number,
  totalChunks: number
) => `
Bạn là biên tập viên truyện tiếng Việt chuyên nghiệp.

NHIỆM VỤ:
- Viết lại CHUNK ${chunkIndex + 1}/${totalChunks} của truyện.
- Giữ nguyên ý chính, giữ trình tự sự kiện, giữ đủ ý.
- Không rút gọn, không tóm tắt.
- Viết câu liền mạch, tự nhiên, không tủn mủn.

RÀNG BUỘC ĐỘ DÀI:
- Đầu ra phải tương đương hoặc dài hơn nhẹ so với đoạn gốc.
- Không cắt mất hội thoại hoặc thông tin.

QUY TẮC TÊN NHÂN VẬT:
${renameCharacters
    ? "- Tự đổi tên nhân vật sang tên mới phù hợp ngữ cảnh và giữ nhất quán."
    : "- Giữ nguyên tên nhân vật như bản gốc."}

NGỮ CẢNH VỪA VIẾT (để nối mạch):
"...${String(previousOutput || "").slice(-900)}"

ĐOẠN GỐC CẦN VIẾT LẠI:
"""
${originalChunk}
"""

Chỉ trả về nội dung đã viết lại, không thêm giải thích.
`;

const rewriteWithGemini = async (apiKey: string, prompt: string) => {
  const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: prompt,
    });
    return String(response.text || "").trim();
  } catch {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });
    return String(response.text || "").trim();
  }
};

const rewriteWithOpenAI = async (apiKey: string, prompt: string) => {
  const openai = new OpenAI({ apiKey: apiKey.trim() });
  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content: "Bạn là biên tập viên truyện tiếng Việt. Viết lại mượt, giữ ý, không rút gọn.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });
  return String(response.choices[0]?.message?.content || "").trim();
};

export async function POST(req: NextRequest) {
  try {
    const { text, userId, provider, renameCharacters } = await req.json();
    if (!text || !userId) {
      return NextResponse.json({ error: "Thiếu text hoặc userId." }, { status: 400 });
    }

    const selectedProvider: Provider = provider === "openai" ? "openai" : "gemini";
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "127.0.0.1";

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (!profile || profile.status !== "approved") {
      return NextResponse.json({ error: "Truy cập bị từ chối" }, { status: 403 });
    }

    const apiKeys = profile.api_keys || {};
    let finalKey = "";
    if (selectedProvider === "openai") {
      finalKey =
        apiKeys.openai ||
        (await supabaseAdmin.from("api_vault").select("api_key").eq("provider", "openai").single()).data?.api_key ||
        "";
    } else {
      finalKey =
        apiKeys.gemini ||
        (await supabaseAdmin.from("api_vault").select("api_key").eq("provider", "gemini").single()).data?.api_key ||
        "";
    }

    if (!finalKey) {
      return NextResponse.json({ error: "Chưa cấu hình API key cho provider đã chọn." }, { status: 403 });
    }

    const chunks = splitByParagraphs(String(text), CHUNK_TARGET);
    const rewrittenChunks: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const prompt = buildPrompt(
        chunks[i],
        rewrittenChunks.length > 0 ? rewrittenChunks[rewrittenChunks.length - 1] : "",
        Boolean(renameCharacters),
        i,
        chunks.length
      );

      const output =
        selectedProvider === "openai"
          ? await rewriteWithOpenAI(finalKey, prompt)
          : await rewriteWithGemini(finalKey, prompt);

      rewrittenChunks.push(output || chunks[i]);
    }

    const result = rewrittenChunks.join("\n\n").trim();

    await Promise.all([
      supabaseAdmin
        .from("profiles")
        .update({
          last_active_at: new Date().toISOString(),
          current_ip: ip,
        })
        .eq("id", userId),
      supabaseAdmin.from("usage_logs").insert({
        user_id: userId,
        user_email: profile.email,
        tool_name: `Tool viết lại truyện (${selectedProvider})`,
        char_count: String(text).length,
      }),
    ]);

    return NextResponse.json({
      result,
      chunks: chunks.length,
      provider: selectedProvider,
    });
  } catch (error: any) {
    console.error("Rewrite Story API Error:", error);
    return NextResponse.json({ error: error?.message || "Lỗi hệ thống rewrite." }, { status: 500 });
  }
}
