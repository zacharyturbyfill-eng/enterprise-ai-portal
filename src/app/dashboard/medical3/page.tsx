"use client";

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Clock, LogOut, Mic, Settings, Sparkles, Video, Volume2 } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import SystemAnnouncementBanner from '@/components/SystemAnnouncementBanner';

enum ContentCategory {
  MEDICAL = 'MEDICAL',
  FOOD = 'FOOD',
  LIFESTYLE = 'LIFESTYLE',
  STORYTELLING = 'STORYTELLING',
  GENERAL = 'GENERAL',
}
enum ConversationType {
  MONOLOGUE = 'MONOLOGUE',
  PODCAST_TWO_PEOPLE = 'PODCAST_TWO_PEOPLE',
  PODCAST_MULTI_PEOPLE = 'PODCAST_MULTI_PEOPLE',
}
enum Country {
  VIETNAM = 'VIETNAM',
  KOREA = 'KOREA',
  JAPAN = 'JAPAN',
  USA = 'USA',
}
enum VisualStyle {
  REALISTIC = 'REALISTIC',
  GHIBLI = 'GHIBLI',
  MEDICAL_SIMPLE = 'MEDICAL_SIMPLE',
  MEDICAL_3D = 'MEDICAL_3D',
  IRASUTOYA = 'IRASUTOYA',
  DONG_HO_VIETNAMESE_VILLAGE = 'DONG_HO_VIETNAMESE_VILLAGE',
}
type TranscriptLine = {
  startTimeMs: number;
  endTimeMs: number;
  speaker: string;
  text: string;
  originalLine: string;
};
type VideoSegment = {
  index: number;
  startTimeMs: number;
  endTimeMs: number;
  relevantContext: string;
  generatedPrompt?: string;
};
type GenerationSettings = {
  category: ContentCategory;
  type: ConversationType;
  country: Country;
  style: VisualStyle;
  apiKey: string;
};
type ModelProvider = 'gemini' | 'openai';
type SeoPackage = {
  title: string;
  description: string;
  timestamps: string[];
  hashtags: string[];
  keywords: string[];
};
type SeoLanguage = 'vi' | 'ja' | 'ko' | 'en';
type UserPromptReminder = {
  enabled: boolean;
  message: string;
  imageUrl: string;
  confirmTimes: number;
  onPrompt: boolean;
  onTitle: boolean;
};

const VEO_SEGMENT_DURATION_MS = 8000;

const parseTimestampToMs = (timestamp: string): number | null => {
  const regex = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;
  const match = timestamp.match(regex);
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseInt(match[3], 10);
  const milliseconds = parseInt(match[4], 10);
  return hours * 3600 * 1000 + minutes * 60 * 1000 + seconds * 1000 + milliseconds;
};

const parseTranscript = (rawText: string) => {
  const parsedLines: TranscriptLine[] = [];
  let globalStart = Infinity;
  let globalEnd = -Infinity;
  const normalizedText = rawText.replace(/\r\n/g, '\n').trim();
  const srtBlocks = normalizedText.split(/\n\s*\n/);
  let isSrt = false;

  for (const block of srtBlocks) {
    const srtMatch = block.match(/^\d+\s*\n(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*\n([\s\S]*)$/);
    if (!srtMatch) continue;
    isSrt = true;
    const startMs = parseTimestampToMs(srtMatch[1]);
    const endMs = parseTimestampToMs(srtMatch[2]);
    const content = srtMatch[3].trim().replace(/\n/g, ' ');
    if (startMs === null || endMs === null) continue;
    parsedLines.push({ startTimeMs: startMs, endTimeMs: endMs, speaker: 'Speaker', text: content, originalLine: block.trim() });
    if (startMs < globalStart) globalStart = startMs;
    if (endMs > globalEnd) globalEnd = endMs;
  }

  if (!isSrt) {
    const lines = rawText.split('\n');
    const lineRegex = /\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*-\s*\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s*\|\s*(.*)/;
    for (const line of lines) {
      const match = line.match(lineRegex);
      if (!match) continue;
      const startMs = parseTimestampToMs(match[1]);
      const endMs = parseTimestampToMs(match[2]);
      if (startMs === null || endMs === null) continue;
      const content = match[3].trim();
      const colonIndex = content.indexOf(':');
      let speaker = 'Speaker';
      let text = content;
      if (colonIndex !== -1 && colonIndex < 30) {
        speaker = content.substring(0, colonIndex).trim();
        text = content.substring(colonIndex + 1).trim();
      }
      parsedLines.push({ startTimeMs: startMs, endTimeMs: endMs, speaker, text, originalLine: line.trim() });
      if (startMs < globalStart) globalStart = startMs;
      if (endMs > globalEnd) globalEnd = endMs;
    }
  }

  return {
    lines: parsedLines,
    startTimeMs: globalStart === Infinity ? 0 : globalStart,
    endTimeMs: globalEnd === -Infinity ? 0 : globalEnd,
  };
};

const createSegments = (startTimeMs: number, endTimeMs: number, transcriptLines: TranscriptLine[]): VideoSegment[] => {
  const segments: VideoSegment[] = [];
  const totalDuration = endTimeMs - startTimeMs;
  const numSegments = Math.ceil(totalDuration / VEO_SEGMENT_DURATION_MS);
  for (let i = 0; i < numSegments; i++) {
    const segmentStart = startTimeMs + i * VEO_SEGMENT_DURATION_MS;
    const segmentEnd = segmentStart + VEO_SEGMENT_DURATION_MS;
    const relevantLines = transcriptLines.filter((line) => line.startTimeMs < segmentEnd && line.endTimeMs > segmentStart);
    const contextText = relevantLines.map((l) => l.text).join(' ');
    segments.push({
      index: i + 1,
      startTimeMs: segmentStart,
      endTimeMs: segmentEnd,
      relevantContext: contextText || '[NO_CONTENT_AMBIENT_SHOT]',
    });
  }
  return segments;
};

export default function Medical3Page() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [transcript, setTranscript] = useState('');
  const [settings, setSettings] = useState<GenerationSettings>({
    category: ContentCategory.LIFESTYLE,
    type: ConversationType.MONOLOGUE,
    country: Country.VIETNAM,
    style: VisualStyle.REALISTIC,
    apiKey: '',
  });
  const [segments, setSegments] = useState<VideoSegment[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [spacingMode, setSpacingMode] = useState<'single' | 'double'>('single');
  const [copied, setCopied] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [provider, setProvider] = useState<ModelProvider>('gemini');
  const [seoPackage, setSeoPackage] = useState<SeoPackage | null>(null);
  const [showSeoBox, setShowSeoBox] = useState(false);
  const [copiedSeo, setCopiedSeo] = useState(false);
  const [generatingSeo, setGeneratingSeo] = useState(false);
  const [translatingSeo, setTranslatingSeo] = useState<SeoLanguage | null>(null);
  const [seoLang, setSeoLang] = useState<SeoLanguage>('vi');
  const [showKidsWarnStep1, setShowKidsWarnStep1] = useState(false);
  const [reminderStep, setReminderStep] = useState(1);
  const [reminderAgree, setReminderAgree] = useState(false);
  const [activeReminder, setActiveReminder] = useState<UserPromptReminder | null>(null);
  const kidsWarnResolverRef = useRef<((value: boolean) => void) | null>(null);

  const fetchHistory = async (userId: string) => {
    const { data } = await supabase
      .from('prompt_history')
      .select('*')
      .eq('user_id', userId)
      .eq('style', 'medical3')
      .order('created_at', { ascending: false })
      .limit(20);
    setHistory(data || []);
  };

  useEffect(() => {
    const checkUser = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push('/login');
        return;
      }
      const { data: profile } = await supabase.from('profiles').select('status, role').eq('id', session.user.id).single();
      if (!profile || profile.status !== 'approved') {
        await supabase.auth.signOut();
        router.push('/login');
        return;
      }
      setUser({ ...session.user, role: profile.role });
      fetchHistory(session.user.id);
    };
    checkUser();
  }, [router]);

  const generatePromptsBatch = async (
    batch: VideoSegment[],
    localContext: string
  ): Promise<Array<{ segmentIndex: number; prompt: string }>> => {
    const res = await fetch('/api/medical3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'generate_batch',
        provider,
        userId: user.id,
        segments: batch.map((b) => ({ index: b.index, relevantContext: b.relevantContext })),
        localContext,
        settings,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Lỗi gọi AI batch');
    return json.results || [];
  };

  const handleGenerate = async () => {
    if (!transcript.trim() || !user) return;
    const ok = await confirmReminderIfNeeded('prompt');
    if (!ok) return;
    setIsProcessing(true);
    setProgress(1);
    try {
      const { lines, startTimeMs, endTimeMs } = parseTranscript(transcript);
      if (lines.length === 0) {
        alert('Không tìm thấy dữ liệu. Vui lòng kiểm tra lại định dạng transcript.');
        setIsProcessing(false);
        return;
      }

      const initialSegments = createSegments(startTimeMs, endTimeMs, lines);
      const totalSegments = initialSegments.length;
      setSegments(initialSegments);
      setProgress(5);

      const BATCH_SIZE = 10;
      const currentSegments = [...initialSegments];
      for (let i = 0; i < totalSegments; i += BATCH_SIZE) {
        const batch = currentSegments.slice(i, Math.min(i + BATCH_SIZE, totalSegments));
        const startLineIdx = Math.max(0, Math.floor((i / totalSegments) * lines.length) - 3);
        const localContext = lines.slice(startLineIdx, startLineIdx + 12).map((l) => l.text).join(' ');
        const results = await generatePromptsBatch(batch, localContext);

        results.forEach((res) => {
          const sIdx = currentSegments.findIndex((s) => s.index === res.segmentIndex);
          if (sIdx !== -1) currentSegments[sIdx].generatedPrompt = res.prompt;
        });

        batch.forEach((seg) => {
          const sIdx = currentSegments.findIndex((s) => s.index === seg.index);
          if (sIdx !== -1 && !currentSegments[sIdx].generatedPrompt) {
            const raw =
              seg.relevantContext !== '[NO_CONTENT_AMBIENT_SHOT]'
                ? seg.relevantContext
                : 'A simple realistic scene of a Vietnamese household environment';
            currentSegments[sIdx].generatedPrompt = `Realistic handheld shot of: ${raw}. Authentic Vietnamese daily life style, 4k, natural lighting.`;
          }
        });

        setSegments([...currentSegments]);
        setProgress(5 + ((i + batch.length) / totalSegments) * 95);
        await new Promise((r) => setTimeout(r, 150));
      }

      const saveRes = await fetch('/api/medical3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_history',
          provider,
          userId: user.id,
          transcript,
          settings,
          segments: currentSegments,
        }),
      });
      const saveJson = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveJson.error || 'Lỗi lưu lịch sử');

      fetchHistory(user.id);
    } catch (error: any) {
      alert(error?.message || 'Đã có lỗi xảy ra. Vui lòng thử lại.');
    } finally {
      setIsProcessing(false);
      setProgress(100);
    }
  };

  const handleCopy = () => {
    const text = segments
      .filter((s) => s.generatedPrompt)
      .map((s) => `${s.index}. ${s.generatedPrompt}`)
      .join(spacingMode === 'single' ? '\n' : '\n\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copySeoPackage = () => {
    if (!seoPackage) return;
    navigator.clipboard.writeText(buildSeoText(seoPackage));
    setCopiedSeo(true);
    setTimeout(() => setCopiedSeo(false), 1800);
  };

  const buildSeoText = (pkg: SeoPackage) => {
    const heading = seoLang === 'ja'
      ? '詳細タイムスタンプ'
      : seoLang === 'ko'
      ? '상세 타임스탬프'
      : seoLang === 'en'
      ? 'DETAILED TIMESTAMPS'
      : 'NỘI DUNG CHI TIẾT (TIME STAMPS)';
    const keywordLabel = seoLang === 'ja'
      ? '追加SEOキーワード'
      : seoLang === 'ko'
      ? '추가 SEO 키워드'
      : seoLang === 'en'
      ? 'ADDITIONAL SEO KEYWORDS'
      : 'TỪ KHÓA SEO BỔ SUNG';
    return [
      pkg.title,
      '',
      pkg.description,
      '',
      `${heading}:`,
      ...pkg.timestamps,
      '',
      pkg.hashtags.join(' '),
      '',
      `${keywordLabel}: ${pkg.keywords.join(', ')}`,
    ].join('\n');
  };

  const handleGenerateSeo = async () => {
    if (!transcript.trim() || !user?.id || generatingSeo) return;
    const ok = await confirmReminderIfNeeded('title');
    if (!ok) return;
    setGeneratingSeo(true);
    try {
      const response = await fetch('/api/medical3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate_seo',
          userId: user.id,
          provider,
          transcript,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || 'Lỗi tạo mô tả video YouTube');
      if (!json?.seo) throw new Error('API chưa trả về dữ liệu mô tả.');
      setSeoPackage(json.seo);
      setSeoLang((json?.lang as SeoLanguage) || 'vi');
      setShowSeoBox(true);
    } catch (err: any) {
      alert(err?.message || 'Lỗi tạo mô tả video YouTube');
    } finally {
      setGeneratingSeo(false);
    }
  };

  const handleTranslateSeo = async (targetLang: SeoLanguage) => {
    if (!seoPackage || !user?.id || translatingSeo) return;
    setTranslatingSeo(targetLang);
    try {
      const response = await fetch('/api/medical3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'translate_seo',
          userId: user.id,
          provider,
          seo: seoPackage,
          targetLang,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json?.error || 'Lỗi dịch mô tả SEO.');
      if (!json?.seo) throw new Error('Không có dữ liệu sau khi dịch.');
      setSeoPackage(json.seo);
      setSeoLang((json?.lang as SeoLanguage) || targetLang);
    } catch (err: any) {
      alert(err?.message || 'Lỗi dịch mô tả SEO.');
    } finally {
      setTranslatingSeo(null);
    }
  };

  if (!user) return <div className="min-h-screen bg-slate-900" />;
  const getUserReminder = async (): Promise<UserPromptReminder | null> => {
    if (!user?.id) return null;
    try {
      const res = await fetch('/api/admin/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_user_prompt_reminder', targetUserId: user.id }),
      });
      const json = await res.json();
      if (!res.ok) return null;
      const reminder = json?.reminder;
      if (!reminder) return null;
      return {
        enabled: Boolean(reminder.enabled),
        message: String(reminder.message || ''),
        imageUrl: String(reminder.imageUrl || ''),
        confirmTimes: Math.max(1, Math.min(10, Number(reminder.confirmTimes || 1))),
        onPrompt: reminder.onPrompt === undefined ? true : Boolean(reminder.onPrompt),
        onTitle: Boolean(reminder.onTitle),
      };
    } catch {
      return null;
    }
  };

  const confirmReminderIfNeeded = async (trigger: 'prompt' | 'title') => {
    const reminder = await getUserReminder();
    if (!reminder?.enabled) return true;
    const triggerMatched = trigger === 'prompt' ? reminder.onPrompt : reminder.onTitle;
    if (!triggerMatched) return true;

    return new Promise<boolean>((resolve) => {
      kidsWarnResolverRef.current = resolve;
      setActiveReminder(reminder);
      setReminderStep(1);
      setReminderAgree(false);
      setShowKidsWarnStep1(true);
    });
  };

  const confirmKidsStep1 = () => {
    if (!activeReminder) return;
    if (!reminderAgree) return;
    if (reminderStep < activeReminder.confirmTimes) {
      setReminderStep((prev) => prev + 1);
      setReminderAgree(false);
      return;
    }
    setShowKidsWarnStep1(false);
    if (kidsWarnResolverRef.current) {
      kidsWarnResolverRef.current(true);
      kidsWarnResolverRef.current = null;
    }
    setActiveReminder(null);
  };

  const cancelKidsWarning = () => {
    setShowKidsWarnStep1(false);
    setReminderStep(1);
    setReminderAgree(false);
    setActiveReminder(null);
    if (kidsWarnResolverRef.current) {
      kidsWarnResolverRef.current(false);
      kidsWarnResolverRef.current = null;
    }
  };

  return (
    <div className="flex h-screen bg-[#020617] text-slate-200 font-sans overflow-hidden">
      <aside className="w-20 md:w-64 bg-[#0f172a]/80 backdrop-blur-xl border-r border-white/5 flex flex-col flex-shrink-0 z-20">
        <div className="h-20 flex items-center px-6 border-b border-white/5">
          <div className="w-10 h-10 btn-ombre rounded-xl flex items-center justify-center text-white font-bold text-2xl font-serif">S</div>
          <span className="ml-3 font-serif font-bold text-xl hidden md:block text-gradient">NovaForge AI</span>
        </div>
        <nav className="flex-1 py-8 px-3 space-y-2">
          <button onClick={() => router.push('/dashboard/cleaner')} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all"><Sparkles className="w-5 h-5 flex-shrink-0" /><span className="ml-3 font-medium hidden md:block">Làm Sạch Transcript</span></button>
          <button onClick={() => router.push('/dashboard/prompter')} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all"><Video className="w-5 h-5 flex-shrink-0" /><span className="ml-3 font-medium hidden md:block">Tạo Prompt Video</span></button>
          <button onClick={() => router.push('/dashboard/voice')} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all"><Volume2 className="w-5 h-5 flex-shrink-0" /><span className="ml-3 font-medium hidden md:block">Giọng Nói AI (ai84)</span></button>
          <button onClick={() => router.push('/dashboard/voice-ai33')} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all"><Volume2 className="w-5 h-5 flex-shrink-0 text-cyan-400" /><span className="ml-3 font-medium hidden md:block">Giọng Nói AI (ai33)</span></button>
          <button onClick={() => router.push('/dashboard/podcast')} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all"><Mic className="w-5 h-5 flex-shrink-0" /><span className="ml-3 font-medium hidden md:block">Podcast Studio</span></button>
          <button onClick={() => router.push('/dashboard/rewriter')} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all"><Sparkles className="w-5 h-5 flex-shrink-0 text-fuchsia-300" /><span className="ml-3 font-medium hidden md:block">Tool viết lại truyện</span></button>
          <button className="w-full flex items-center p-4 rounded-2xl bg-white/[0.03] text-white border border-white/5 shadow-lg"><Video className="w-5 h-5 flex-shrink-0 text-orange-400" /><span className="ml-3 font-semibold hidden md:block">Prompt Medical 3.0</span></button>
          {user?.role === 'admin' && <button onClick={() => router.push('/admin')} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-slate-800/50 hover:text-white transition-all"><Settings className="w-5 h-5 flex-shrink-0" /><span className="ml-3 font-medium hidden md:block">Quản Trị Admin</span></button>}
        </nav>
        <div className="p-6 border-t border-white/5">
          <button onClick={async () => { await supabase.auth.signOut(); router.push('/login'); }} className="w-full flex items-center justify-center gap-2 p-3 rounded-xl text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-all text-sm font-semibold">
            <LogOut className="w-4 h-4" /> <span className="hidden md:block">Đăng Xuất</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 p-4 lg:p-6 overflow-y-auto">
        <SystemAnnouncementBanner userId={user?.id} />
        <div className="bg-slate-900 border border-slate-800 p-4 sticky top-0 z-20 rounded-xl mb-4">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-gradient-to-br from-orange-500 to-red-600 rounded-lg flex items-center justify-center shadow-lg">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
              </div>
              <div>
                <h1 className="text-xl font-bold text-white tracking-tight">Veo3 Realism Engine</h1>
                <p className="text-[10px] text-orange-400 uppercase font-bold tracking-widest">Bám Sát Lời Thoại • Chân Thực • Đời Thường</p>
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-3">
              <button onClick={() => { setShowHistory(true); fetchHistory(user.id); }} className="flex items-center gap-2 px-5 py-2 bg-white/5 hover:bg-white/10 text-slate-300 rounded-lg border border-slate-700 text-xs font-bold">
                <Clock size={14} /> Lịch sử
              </button>
              {isProcessing && <span className="flex items-center gap-2 text-xs font-bold text-orange-500 animate-pulse bg-orange-500/10 px-3 py-1 rounded-full border border-orange-500/20">⚡ {provider === 'openai' ? 'ĐANG KẾT NỐI GPT-4.1 MINI' : 'ĐANG KẾT NỐI GEMINI 2.5 FLASH LITE'}</span>}
            </div>
          </div>
        </div>

        <div className="mb-4 bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-blue-300">Mô Tả Video SEO</p>
              <p className="text-[10px] text-slate-500">Tạo riêng cho video YouTube chuẩn SEO</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowSeoBox((v) => !v)}
                className="px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-slate-700 text-[10px] font-bold uppercase tracking-widest text-slate-300"
              >
                {showSeoBox ? 'Thu Gọn' : 'Xổ Ra'}
              </button>
              <button
                type="button"
                onClick={copySeoPackage}
                disabled={!seoPackage}
                className="px-4 py-2 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-[10px] font-bold uppercase tracking-widest text-indigo-100 disabled:opacity-40"
              >
                {copiedSeo ? 'Đã Copy' : 'Copy Mô Tả'}
              </button>
            </div>
          </div>
          {showSeoBox && (
            <div className="mt-3 rounded-xl bg-slate-950 border border-slate-800 p-4">
              {!seoPackage ? (
                <p className="text-xs text-slate-500 italic">Chưa có dữ liệu mô tả. Hãy bấm nút "Tạo mô tả YouTube chuẩn SEO".</p>
              ) : (
                <div className="space-y-3 text-sm text-slate-200">
                  <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans">{buildSeoText(seoPackage)}</pre>
                  <div className="pt-2 border-t border-slate-800">
                    <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-2">Dịch nhanh mô tả</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => handleTranslateSeo('vi')}
                        disabled={!!translatingSeo}
                        className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase border ${seoLang === 'vi' ? 'bg-blue-600/30 text-blue-100 border-blue-400/40' : 'bg-white/5 text-slate-300 border-slate-700'} disabled:opacity-40`}
                      >
                        {translatingSeo === 'vi' ? '...' : 'VI'}
                      </button>
                      <button
                        onClick={() => handleTranslateSeo('ja')}
                        disabled={!!translatingSeo}
                        className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase border ${seoLang === 'ja' ? 'bg-blue-600/30 text-blue-100 border-blue-400/40' : 'bg-white/5 text-slate-300 border-slate-700'} disabled:opacity-40`}
                      >
                        {translatingSeo === 'ja' ? '...' : 'JA'}
                      </button>
                      <button
                        onClick={() => handleTranslateSeo('ko')}
                        disabled={!!translatingSeo}
                        className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase border ${seoLang === 'ko' ? 'bg-blue-600/30 text-blue-100 border-blue-400/40' : 'bg-white/5 text-slate-300 border-slate-700'} disabled:opacity-40`}
                      >
                        {translatingSeo === 'ko' ? '...' : 'KO'}
                      </button>
                      <button
                        onClick={() => handleTranslateSeo('en')}
                        disabled={!!translatingSeo}
                        className={`px-3 py-1.5 rounded-md text-[10px] font-bold uppercase border ${seoLang === 'en' ? 'bg-blue-600/30 text-blue-100 border-blue-400/40' : 'bg-white/5 text-slate-300 border-slate-700'} disabled:opacity-40`}
                      >
                        {translatingSeo === 'en' ? '...' : 'EN'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-[calc(100vh-170px)]">
          <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-xl flex flex-col h-full overflow-y-auto">
            <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
              Cấu hình & Kịch bản
            </h2>
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-400 mb-2">Mô hình ngôn ngữ</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setProvider('gemini')}
                  disabled={isProcessing}
                  className={`h-10 rounded-lg border text-sm font-semibold transition-all ${provider === 'gemini' ? 'bg-blue-600 text-white border-blue-500' : 'bg-slate-900 text-slate-300 border-slate-700 hover:border-slate-500'}`}
                >
                  Gemini 2.5 Flash Lite
                </button>
                <button
                  onClick={() => setProvider('openai')}
                  disabled={isProcessing}
                  className={`h-10 rounded-lg border text-sm font-semibold transition-all ${provider === 'openai' ? 'bg-indigo-600 text-white border-indigo-500' : 'bg-slate-900 text-slate-300 border-slate-700 hover:border-slate-500'}`}
                >
                  GPT-4.1 mini
                </button>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Thể loại Nội dung</label>
                <p className="text-[11px] text-blue-300 mb-2 h-8">
                  {settings.category === ContentCategory.MEDICAL && 'Tối ưu cho bối cảnh y tế, bệnh viện, phòng khám.'}
                  {settings.category === ContentCategory.FOOD && 'Tối ưu cho bối cảnh nấu ăn, nhà hàng, thực phẩm.'}
                  {settings.category === ContentCategory.LIFESTYLE && 'Tối ưu cho bối cảnh đời sống, sinh hoạt hàng ngày.'}
                  {settings.category === ContentCategory.STORYTELLING && 'Tối ưu cho bối cảnh kể chuyện, kịch tính, cảm xúc.'}
                  {settings.category === ContentCategory.GENERAL && 'Bối cảnh chung, linh hoạt cho mọi nội dung.'}
                </p>
                <select className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-2 focus:ring-blue-500 outline-none" value={settings.category} onChange={(e) => setSettings({ ...settings, category: e.target.value as ContentCategory })} disabled={isProcessing}>
                  <option value={ContentCategory.MEDICAL}>Y Tế (Medical)</option>
                  <option value={ContentCategory.FOOD}>Ẩm Thực (Food)</option>
                  <option value={ContentCategory.LIFESTYLE}>Đời Sống (Lifestyle)</option>
                  <option value={ContentCategory.STORYTELLING}>Kể Chuyện (Storytelling)</option>
                  <option value={ContentCategory.GENERAL}>Chung (General)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Loại Hội Thoại</label>
                <p className="text-[11px] text-blue-300 mb-2 h-8">
                  {settings.type === ConversationType.PODCAST_TWO_PEOPLE && 'Cấu trúc cho 2 người đối thoại, nhịp độ vừa phải.'}
                  {settings.type === ConversationType.PODCAST_MULTI_PEOPLE && 'Cấu trúc cho nhóm 3+ người, tương tác nhanh, sôi nổi.'}
                  {settings.type === ConversationType.MONOLOGUE && 'Cấu trúc độc thoại, tập trung vào 1 người dẫn dắt.'}
                </p>
                <select className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-2 focus:ring-blue-500 outline-none" value={settings.type} onChange={(e) => setSettings({ ...settings, type: e.target.value as ConversationType })} disabled={isProcessing}>
                  <option value={ConversationType.PODCAST_TWO_PEOPLE}>Podcast 2 Người</option>
                  <option value={ConversationType.PODCAST_MULTI_PEOPLE}>Podcast 3+ Người</option>
                  <option value={ConversationType.MONOLOGUE}>Độc thoại (1 Người)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Quốc gia</label>
                <p className="text-[11px] text-blue-300 mb-2 h-8">
                  {settings.country === Country.VIETNAM && 'Bối cảnh, trang phục, kiến trúc đặc trưng Việt Nam.'}
                  {settings.country === Country.KOREA && 'Bối cảnh, trang phục, kiến trúc đặc trưng Hàn Quốc.'}
                  {settings.country === Country.JAPAN && 'Bối cảnh, trang phục, kiến trúc đặc trưng Nhật Bản.'}
                  {settings.country === Country.USA && 'Bối cảnh, trang phục, kiến trúc đặc trưng Mỹ.'}
                </p>
                <select className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-2 focus:ring-blue-500 outline-none" value={settings.country} onChange={(e) => setSettings({ ...settings, country: e.target.value as Country })} disabled={isProcessing}>
                  <option value={Country.VIETNAM}>Việt Nam</option>
                  <option value={Country.KOREA}>Hàn Quốc</option>
                  <option value={Country.JAPAN}>Nhật Bản</option>
                  <option value={Country.USA}>Mỹ</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-400 mb-1">Phong cách</label>
                <p className="text-[11px] text-blue-300 mb-2 h-8">
                  {settings.style === VisualStyle.REALISTIC && 'Hình ảnh chân thực, đời thường như quay phim.'}
                  {settings.style === VisualStyle.GHIBLI && 'Phong cách hoạt hình nghệ thuật Studio Ghibli.'}
                  {settings.style === VisualStyle.MEDICAL_SIMPLE && 'Hoạt hình 2D đơn giản, dễ hiểu cho y tế.'}
                  {settings.style === VisualStyle.MEDICAL_3D && 'Hình ảnh 3D chi tiết, chuyên nghiệp cho y tế.'}
                  {settings.style === VisualStyle.IRASUTOYA && 'Phong cách minh họa Irasutoya (いらすとや) dễ thương, phổ biến.'}
                  {settings.style === VisualStyle.DONG_HO_VIETNAMESE_VILLAGE && 'Phong cách tranh dân gian Đông Hồ làng quê Việt Nam truyền thống.'}
                </p>
                <select className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-2 focus:ring-blue-500 outline-none" value={settings.style} onChange={(e) => setSettings({ ...settings, style: e.target.value as VisualStyle })} disabled={isProcessing}>
                  <option value={VisualStyle.REALISTIC}>Đời thật</option>
                  <option value={VisualStyle.GHIBLI}>Studio Ghibli</option>
                  <option value={VisualStyle.MEDICAL_SIMPLE}>Hoạt hình y tế đơn giản</option>
                  <option value={VisualStyle.MEDICAL_3D}>3D y tế</option>
                  <option value={VisualStyle.IRASUTOYA}>Irasutoya (いらすとや)</option>
                  <option value={VisualStyle.DONG_HO_VIETNAMESE_VILLAGE}>Tranh Đông Hồ làng quê Việt Nam</option>
                </select>
              </div>
            </div>
            <div className="flex-1 flex flex-col min-h-0">
              <label className="block text-sm font-medium text-slate-400 mb-1">
                Nhập Transcript (Có Timestamp)
                <span className="text-xs text-slate-500 ml-2 block sm:inline">Format: [00:00:00.000] - [00:00:08.000] | Name: Content</span>
              </label>
              <textarea className="flex-1 w-full bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm text-slate-300 font-mono focus:ring-2 focus:ring-blue-500 outline-none resize-none" placeholder="[00:17:34.279] - [00:17:42.290] | Khánh lành: Vậy để cụ thể hóa việc..." value={transcript} onChange={(e) => setTranscript(e.target.value)} disabled={isProcessing} />
            </div>
            <div className="mt-6">
              {isProcessing ? (
                <div className="w-full bg-slate-700 rounded-full h-12 flex items-center justify-center relative overflow-hidden">
                  <div className="absolute left-0 top-0 h-full bg-blue-600 transition-all duration-300 ease-out" style={{ width: `${progress}%` }} />
                  <span className="relative z-10 font-bold text-white flex items-center gap-2">
                    <svg className="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    Đang xử lý... {Math.round(progress)}%
                  </span>
                </div>
              ) : (
                <div className="space-y-2">
                  <button onClick={handleGenerate} disabled={!transcript.trim()} className="w-full h-12 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-lg shadow-lg transform transition active:scale-[0.98] flex items-center justify-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" /></svg>
                    Tạo Prompts (Text Only)
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateSeo}
                    disabled={generatingSeo || !transcript.trim()}
                    className="w-full h-11 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 text-blue-200 text-xs font-bold uppercase tracking-widest disabled:opacity-40 flex items-center justify-center gap-2"
                  >
                    {generatingSeo ? (
                      <>
                        <svg className="animate-spin h-4 w-4 text-blue-200" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                        Đang tạo mô tả YouTube...
                      </>
                    ) : (
                      'Tạo mô tả YouTube chuẩn SEO'
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-xl h-full flex flex-col">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-4">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold text-white">Danh Sách Prompts ({segments.length})</h2>
                <span className="px-2 py-0.5 bg-blue-500/20 text-blue-400 text-[10px] uppercase tracking-wider font-bold rounded border border-blue-500/30">8s Segments</span>
              </div>
              <div className="flex items-center gap-2 bg-slate-900 p-1 rounded-lg border border-slate-700">
                <button onClick={() => setSpacingMode('single')} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${spacingMode === 'single' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}>Đơn</button>
                <button onClick={() => setSpacingMode('double')} className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${spacingMode === 'double' ? 'bg-blue-600 text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}>Đôi</button>
              </div>
            </div>
            {segments.length === 0 ? (
              <div className="bg-slate-800 rounded-xl border border-slate-700 h-full flex flex-col items-center justify-center text-slate-500">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mb-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" /></svg>
                <p className="text-center font-medium">Chưa có kết quả.<br /><span className="text-sm opacity-60">Nhập transcript để bắt đầu kiến trúc video.</span></p>
              </div>
            ) : (
              <>
                <div className="flex-1 bg-slate-900 rounded-lg p-5 overflow-y-auto border border-slate-700 font-mono text-sm leading-relaxed text-slate-300">
                  {segments.map((seg) => (
                    <div key={seg.index} className={spacingMode === 'double' ? 'mb-8' : 'mb-4'}>
                      <div className="text-blue-500 font-bold mb-1">{seg.index}. Transcript:</div>
                      <div className="text-slate-400 italic mb-2 bg-slate-800/50 p-2 rounded">{seg.relevantContext}</div>
                      <div className="text-blue-500 font-bold mb-1">Prompt:</div>
                      <div className="text-slate-200">{seg.generatedPrompt || <span className="text-slate-600 animate-pulse italic">Đang kiến tạo...</span>}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-5">
                  <button onClick={handleCopy} className={`w-full h-12 font-bold rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all transform active:scale-[0.97] ${copied ? 'bg-emerald-600 text-white' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}>
                    {copied ? (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                        Đã Sao Chép! (Định dạng đánh số)
                      </>
                    ) : (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" /><path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" /></svg>
                        Sao Chép Danh Sách
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      <AnimatePresence>
        {showHistory && (
          <div className="fixed inset-0 z-50 flex justify-end bg-[#020617]/80 backdrop-blur-md">
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} className="w-full max-w-lg bg-[#0f172a] h-full shadow-2xl flex flex-col border-l border-white/5">
              <div className="p-8 border-b border-white/5 flex items-center justify-between">
                <h3 className="text-xl font-bold text-white font-serif">Lịch sử Prompt Medical 3.0</h3>
                <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-white/10 rounded-full text-slate-500">✕</button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-hide">
                {history.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => {
                      setTranscript(h.input_transcript || '');
                      setSegments(Array.isArray(h.results) ? h.results : []);
                      setSettings((prev) => ({
                        ...prev,
                        category: (h.genre as ContentCategory) || prev.category,
                        country: (h.nationality as Country) || prev.country,
                      }));
                      setProvider(h.provider === 'openai' ? 'openai' : 'gemini');
                      setShowHistory(false);
                    }}
                    className="w-full p-5 bg-white/[0.02] border border-white/5 rounded-2xl hover:bg-white/5 transition-all text-left"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-widest font-black text-orange-400">Medical 3.0 • {h.provider === 'openai' ? 'GPT-4.1 mini' : 'Gemini 2.5 Flash Lite'}</span>
                      <span className="text-[10px] text-slate-500">{new Date(h.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-slate-400 italic line-clamp-2">"{String(h.input_transcript || '').slice(0, 140)}..."</p>
                  </button>
                ))}
                {history.length === 0 && <p className="text-slate-500 text-xs italic">Chưa có lịch sử.</p>}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showKidsWarnStep1 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[120] flex items-center justify-center bg-[#020617]/90 backdrop-blur-md p-6">
            <motion.div initial={{ y: 20, scale: 0.98 }} animate={{ y: 0, scale: 1 }} className="max-w-xl w-full bg-slate-900 border border-amber-400/30 rounded-3xl p-7">
              <h3 className="text-xl font-bold text-amber-300 mb-2">Nhắc nhở quan trọng</h3>
              <p className="text-[11px] text-slate-500 mb-3 uppercase tracking-widest font-black">Xác nhận {reminderStep}/{activeReminder?.confirmTimes || 1}</p>
              <p className="text-sm text-slate-200 whitespace-pre-wrap">{activeReminder?.message || 'Vui lòng đọc kỹ nhắc nhở trước khi tiếp tục.'}</p>
              {activeReminder?.imageUrl && (
                <div className="mt-4 rounded-2xl overflow-hidden border border-white/10">
                  <img src={activeReminder.imageUrl} alt="Reminder" className="w-full h-auto" />
                </div>
              )}
              <label className="mt-4 flex items-center gap-3 text-sm text-slate-300">
                <input type="checkbox" checked={reminderAgree} onChange={(e) => setReminderAgree(e.target.checked)} />
                Tôi đã đọc và hiểu nhắc nhở này
              </label>
              <div className="mt-6 flex justify-end gap-3">
                <button onClick={cancelKidsWarning} className="px-4 py-2 rounded-xl border border-white/10 text-slate-300">Hủy</button>
                <button onClick={confirmKidsStep1} disabled={!reminderAgree} className="px-4 py-2 rounded-xl bg-amber-500/20 border border-amber-400/30 text-amber-200 font-bold disabled:opacity-40">
                  {reminderStep >= (activeReminder?.confirmTimes || 1) ? 'Tiếp tục tạo prompt' : 'Xác nhận lần tiếp theo'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
