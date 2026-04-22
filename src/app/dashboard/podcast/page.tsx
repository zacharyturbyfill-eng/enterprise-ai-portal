"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import {
  Mic,
  Sparkles,
  Video,
  Volume2,
  Settings,
  LogOut,
  Cpu,
  Zap,
  Loader2,
  Copy,
  Check,
  Clock,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import SystemAnnouncementBanner from "@/components/SystemAnnouncementBanner";

type PodcastRole = {
  id: string;
  name: string;
  roleType: "Host" | "Doctor" | "Guest";
  selected: boolean;
  gender: "Nam" | "Nữ";
};

type DialogueLine = {
  speaker: string;
  text: string;
  roleType: "Host" | "Doctor" | "Guest";
};

const DOCTOR_MEMORY_KEY = "podcast_recent_doctor_names";

export default function PodcastPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [provider, setProvider] = useState<"gemini" | "openai">("gemini");
  const [inputText, setInputText] = useState("");
  const [projectTitle, setProjectTitle] = useState("");
  const [lines, setLines] = useState<DialogueLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [recentDoctorNames, setRecentDoctorNames] = useState<string[]>([]);
  const [roles, setRoles] = useState<PodcastRole[]>([
    { id: "1", name: "Thanh Tâm", roleType: "Host", selected: true, gender: "Nữ" },
    { id: "2", name: "Lê Hải", roleType: "Doctor", selected: true, gender: "Nam" },
    { id: "3", name: "Phương Anh", roleType: "Doctor", selected: false, gender: "Nữ" },
  ]);

  const activeRoleCount = useMemo(() => roles.filter((r) => r.selected).length, [roles]);
  const inputCharCount = inputText.length;
  const outputCharCount = useMemo(
    () => lines.reduce((sum, line) => sum + (line.text?.length || 0), 0),
    [lines]
  );

  const fetchHistory = async (userId: string) => {
    const { data } = await supabase
      .from("prompt_history")
      .select("*")
      .eq("user_id", userId)
      .eq("style", "podcast")
      .order("created_at", { ascending: false })
      .limit(20);
    setHistory(data || []);
  };

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("status, role")
        .eq("id", session.user.id)
        .single();
      if (!profile || profile.status !== "approved") {
        await supabase.auth.signOut();
        router.push("/login");
        return;
      }
      setUser({ ...session.user, role: profile.role });
      fetchHistory(session.user.id);
    };
    checkAuth();
  }, [router]);

  useEffect(() => {
    const seededText = localStorage.getItem("podcast_prefill_text");
    const seededTitle = localStorage.getItem("podcast_prefill_title");
    if (seededText) {
      setInputText(seededText);
      localStorage.removeItem("podcast_prefill_text");
    }
    if (seededTitle) {
      setProjectTitle(seededTitle);
      localStorage.removeItem("podcast_prefill_title");
    }
    try {
      const rawDoctors = localStorage.getItem(DOCTOR_MEMORY_KEY);
      const parsedDoctors = rawDoctors ? (JSON.parse(rawDoctors) as string[]) : [];
      const normalized = parsedDoctors.filter(Boolean).slice(0, 8);
      setRecentDoctorNames(normalized);
      if (normalized.length > 0) {
        setRoles((prev) => {
          let doctorIndex = 0;
          return prev.map((r) => {
            if (r.roleType !== "Doctor") return r;
            const nextName = normalized[doctorIndex] || r.name;
            doctorIndex += 1;
            return { ...r, name: nextName };
          });
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    const doctors = roles
      .filter((r) => r.roleType === "Doctor")
      .map((r) => r.name.trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...doctors, ...recentDoctorNames])).slice(0, 8);
    setRecentDoctorNames((prev) => {
      const prevKey = prev.join("|");
      const nextKey = merged.join("|");
      return prevKey === nextKey ? prev : merged;
    });
    localStorage.setItem(DOCTOR_MEMORY_KEY, JSON.stringify(merged));
  }, [roles]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleRole = (id: string) => {
    setRoles((prev) => {
      const target = prev.find((r) => r.id === id);
      const activeCount = prev.filter((r) => r.selected).length;
      if (target?.selected && activeCount <= 1) {
        alert("Cần giữ tối thiểu 1 nhân vật.");
        return prev;
      }
      return prev.map((r) => (r.id === id ? { ...r, selected: !r.selected } : r));
    });
  };

  const generatePodcast = async () => {
    if (!user || !inputText.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/podcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          text: inputText,
          title: projectTitle,
          provider,
          roles,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Tạo podcast thất bại.");
      setLines(data.results || []);
      fetchHistory(user.id);
    } catch (e: any) {
      alert(e?.message || "Lỗi tạo podcast.");
    } finally {
      setLoading(false);
    }
  };

  const copyAll = async () => {
    if (lines.length === 0) return;
    const text = lines.map((line) => `${line.speaker}: ${line.text}`).join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const sendToVoiceConversation = () => {
    if (lines.length === 0) return;
    const conversationText = lines.map((line) => `${line.speaker}: ${line.text}`).join("\n");
    localStorage.setItem("voice_prefill_mode", "conversation");
    localStorage.setItem("voice_prefill_text", conversationText);
    if (projectTitle.trim()) {
      localStorage.setItem("voice_prefill_title", projectTitle.trim());
    }
    router.push("/dashboard/voice");
  };

  if (!user) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#020617]">
        <Loader2 className="animate-spin text-indigo-500 w-10 h-10" />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#020617] text-slate-200 font-sans overflow-hidden">
      <aside className="w-20 md:w-64 bg-[#0f172a]/80 backdrop-blur-xl border-r border-white/5 flex flex-col flex-shrink-0 z-20">
        <div className="h-20 flex items-center px-6 border-b border-white/5">
          <div className="w-10 h-10 btn-ombre rounded-xl flex items-center justify-center text-white font-bold text-2xl font-serif">S</div>
          <span className="ml-3 font-serif font-bold text-xl hidden md:block text-gradient">NovaForge AI</span>
        </div>

        <nav className="flex-1 py-8 px-3 space-y-2">
          <button onClick={() => router.push("/dashboard/cleaner")} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all">
            <Sparkles className="w-5 h-5 flex-shrink-0" />
            <span className="ml-3 font-medium hidden md:block">Làm Sạch Transcript</span>
          </button>
          <button onClick={() => router.push("/dashboard/prompter")} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all">
            <Video className="w-5 h-5 flex-shrink-0" />
            <span className="ml-3 font-medium hidden md:block">Tạo Prompt Video</span>
          </button>
          <button onClick={() => router.push("/dashboard/voice")} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all">
            <Volume2 className="w-5 h-5 flex-shrink-0" />
            <span className="ml-3 font-medium hidden md:block">Giọng Nói AI (ai84)</span>
          </button>

          <button onClick={() => router.push("/dashboard/voice-ai33")} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all">
            <Volume2 className="w-5 h-5 flex-shrink-0 text-cyan-400" />
            <span className="ml-3 font-medium hidden md:block">Giọng Nói AI (ai33)</span>
          </button>
          <button className="w-full flex items-center p-4 rounded-2xl bg-white/[0.03] text-white border border-white/5 shadow-lg">
            <Mic className="w-5 h-5 flex-shrink-0 text-indigo-400" />
            <span className="ml-3 font-semibold hidden md:block">Podcast Studio</span>
          </button>
          <button onClick={() => router.push('/dashboard/rewriter')} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all">
            <Sparkles className="w-5 h-5 flex-shrink-0 text-fuchsia-300" />
            <span className="ml-3 font-medium hidden md:block">Tool viết lại truyện</span>
          </button>
          <button onClick={() => router.push('/dashboard/medical3')} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-white/5 hover:text-white transition-all">
            <Video className="w-5 h-5 flex-shrink-0" />
            <span className="ml-3 font-medium hidden md:block">Prompt Medical 3.0</span>
          </button>
          {user?.role === "admin" && (
            <button onClick={() => router.push("/admin")} className="w-full flex items-center p-4 rounded-2xl text-slate-400 hover:bg-slate-800/50 hover:text-white transition-all">
              <Settings className="w-5 h-5 flex-shrink-0" />
              <span className="ml-3 font-medium hidden md:block">Quản Trị Admin</span>
            </button>
          )}
        </nav>

        <div className="p-6 border-t border-white/5">
          <button
            onClick={async () => {
              await supabase.auth.signOut();
              router.push("/login");
            }}
            className="w-full flex items-center justify-center gap-2 p-3 rounded-xl text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-all text-sm font-semibold"
          >
            <LogOut className="w-4 h-4" /> <span className="hidden md:block">Đăng Xuất</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 p-4 md:p-10 overflow-y-auto">
        <SystemAnnouncementBanner userId={user?.id} />
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h2 className="text-4xl font-bold text-white font-serif tracking-tight mb-2">
              <span className="text-gradient">Podcast Studio</span>
            </h2>
            <p className="text-slate-500 text-[11px] uppercase tracking-widest font-black">
              Model cố định: Gemini 2.5 Flash Lite / GPT-4.1 mini
            </p>
            <div className="mt-3">
              <input
                value={projectTitle}
                onChange={(e) => setProjectTitle(e.target.value)}
                placeholder="Tiêu đề tập podcast..."
                className="w-[340px] max-w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                setShowHistory(true);
                fetchHistory(user.id);
              }}
              className="flex items-center gap-2 px-6 py-2.5 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white rounded-2xl border border-white/5 transition-all text-[10px] font-black uppercase tracking-widest"
            >
              <Clock size={14} /> Lịch Sử Podcast
            </button>
            <div className="glass-card p-1.5 rounded-2xl border-white/10 flex items-center gap-1 shadow-2xl">
              <button onClick={() => setProvider("gemini")} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all ${provider === "gemini" ? "btn-ombre text-white shadow-lg" : "text-slate-500 hover:bg-white/5"}`}>
                <Cpu size={14} /> <span className="text-[10px] font-black uppercase tracking-widest">Gemini 2.5 Flash Lite</span>
              </button>
              <button onClick={() => setProvider("openai")} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-all ${provider === "openai" ? "bg-emerald-600 text-white shadow-lg" : "text-slate-500 hover:bg-white/5"}`}>
                <Zap size={14} /> <span className="text-[10px] font-black uppercase tracking-widest">GPT-4.1 mini</span>
              </button>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-auto lg:h-[calc(100vh-190px)] pb-6">
          <section className="lg:col-span-5 glass-card rounded-[2.5rem] border-white/5 overflow-hidden flex flex-col">
            <div className="p-6 border-b border-white/5">
              <div className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-400 mb-3">Nhân vật</div>
              <div className="space-y-3">
                {roles.map((role) => (
                  <div key={role.id} className={`p-3 rounded-xl border ${role.selected ? "border-indigo-500/30 bg-indigo-500/5" : "border-white/10 bg-black/20"}`}>
                    <div className="flex items-center gap-3">
                      <input type="checkbox" checked={role.selected} onChange={() => toggleRole(role.id)} />
                      <input
                        value={role.name}
                        onChange={(e) => setRoles((prev) => prev.map((r) => (r.id === role.id ? { ...r, name: e.target.value } : r)))}
                        className="flex-1 bg-transparent outline-none text-sm text-white"
                        placeholder="Tên nhân vật"
                        list={role.roleType === "Doctor" ? "doctor-name-suggestions" : undefined}
                      />
                      <span className="text-[10px] uppercase font-black text-slate-500">{role.roleType}</span>
                    </div>
                    {role.selected && (
                      <div className="mt-3 ml-7 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setRoles((prev) => prev.map((r) => (r.id === role.id ? { ...r, gender: "Nam" } : r)))
                          }
                          className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider ${
                            role.gender === "Nam"
                              ? "bg-indigo-600 text-white border border-indigo-400/40"
                              : "bg-black/30 text-slate-400 border border-white/10"
                          }`}
                        >
                          Nam
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setRoles((prev) => prev.map((r) => (r.id === role.id ? { ...r, gender: "Nữ" } : r)))
                          }
                          className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider ${
                            role.gender === "Nữ"
                              ? "bg-pink-600 text-white border border-pink-400/40"
                              : "bg-black/30 text-slate-400 border border-white/10"
                          }`}
                        >
                          Nữ
                        </button>
                        <span className="text-[10px] text-slate-500">
                          {role.roleType === "Doctor" ? "Giới tính bác sĩ quyết định xưng hô" : "Giới tính nhân vật"}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-3 text-[10px] text-slate-500">
                {activeRoleCount === 1 ? "Chế độ độc thoại" : `Chế độ hội thoại (${activeRoleCount} vai)`}
              </div>
              <div className="mt-2 text-[10px] text-indigo-300/80">
                Input: {inputCharCount.toLocaleString()} ký tự
              </div>
              {recentDoctorNames.length > 0 && (
                <div className="mt-2 text-[10px] text-slate-500">
                  Gợi ý tên bác sĩ gần nhất: {recentDoctorNames.join(", ")}
                </div>
              )}
            </div>
            <datalist id="doctor-name-suggestions">
              {recentDoctorNames.map((name) => (
                <option value={name} key={name} />
              ))}
            </datalist>
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Dán nội dung để tạo kịch bản podcast..."
              className="flex-1 bg-transparent p-6 outline-none resize-none text-slate-300 leading-relaxed"
            />
            <div className="p-6 border-t border-white/5">
              <button
                onClick={generatePodcast}
                disabled={loading || !inputText.trim()}
                className="w-full btn-ombre py-4 rounded-2xl font-bold transition-all shadow-xl flex items-center justify-center gap-3 disabled:opacity-30"
              >
                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Mic className="w-5 h-5" />}
                {loading ? "Đang tạo kịch bản..." : "Tạo Kịch Bản Podcast"}
              </button>
            </div>
          </section>

          <section className="lg:col-span-7 glass-card rounded-[2.5rem] border-white/5 overflow-hidden flex flex-col">
            <div className="p-6 border-b border-white/5 flex items-center justify-between">
              <div>
                <div className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-400">Kịch bản đầu ra</div>
                <div className="text-[10px] text-emerald-300/80 mt-1">
                  Output: {outputCharCount.toLocaleString()} ký tự
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={sendToVoiceConversation}
                  disabled={lines.length === 0}
                  className="px-4 py-2 rounded-xl text-xs font-bold border border-indigo-500/30 bg-indigo-500/10 hover:bg-indigo-500/20 disabled:opacity-30 flex items-center gap-2"
                >
                  <Volume2 size={14} />
                  Chuyển sang Giọng Nói AI
                </button>
                <button
                  onClick={copyAll}
                  disabled={lines.length === 0}
                  className="px-4 py-2 rounded-xl text-xs font-bold border border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-30 flex items-center gap-2"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Đã sao chép" : "Copy toàn bộ"}
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-hide">
              {lines.length === 0 && (
                <div className="h-full flex items-center justify-center text-slate-600 text-xs italic">
                  Chưa có kịch bản podcast.
                </div>
              )}
              {lines.map((line, idx) => (
                <div key={`${line.speaker}-${idx}`} className="p-4 rounded-2xl border border-white/5 bg-white/[0.02]">
                  <div className="text-[10px] font-black uppercase tracking-widest text-indigo-300 mb-2">
                    {line.speaker} · {line.roleType}
                  </div>
                  <div className="text-sm text-slate-200 leading-relaxed">{line.text}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>

      <AnimatePresence>
        {showHistory && (
          <div className="fixed inset-0 z-50 flex justify-end bg-[#020617]/80 backdrop-blur-md">
            <motion.div initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} className="w-full max-w-lg bg-[#0f172a] h-full shadow-2xl flex flex-col border-l border-white/5">
              <div className="p-8 border-b border-white/5 flex items-center justify-between">
                <h3 className="text-xl font-bold text-white font-serif">Lịch Sử Podcast</h3>
                <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-white/10 rounded-full text-slate-500"><X /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-hide">
                {history.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => {
                      setInputText(h.input_transcript || "");
                      setLines(Array.isArray(h.results) ? h.results : []);
                      setProvider(h.provider === "openai" ? "openai" : "gemini");
                      setProjectTitle(String(h.genre || "").startsWith("Podcast:") ? String(h.genre).replace(/^Podcast:\s*/i, '') : "");
                      setShowHistory(false);
                    }}
                    className="w-full p-5 bg-white/[0.02] border border-white/5 rounded-2xl hover:bg-white/5 transition-all text-left"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-widest font-black text-indigo-400">
                        {h.provider === "openai" ? "GPT-4.1 mini" : "Gemini 2.5 Flash Lite"}
                      </span>
                      <span className="text-[10px] text-slate-500">{new Date(h.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-slate-400 italic line-clamp-2">"{String(h.input_transcript || "").slice(0, 120)}..."</p>
                  </button>
                ))}
                {history.length === 0 && <p className="text-slate-500 text-xs italic">Chưa có lịch sử podcast.</p>}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
