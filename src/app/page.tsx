"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type SessionInfo = {
  hasSession: boolean;
  isValid: boolean;
  lastChecked?: string;
};

type JoinedCafe = {
  cafeId: string;
  name: string;
  url: string;
};

type ScrapeJob = {
  id: string;
  status: string;
  keywords: string;
  cafeNames: string | null;
  minViewCount: number | null;
  minCommentCount: number | null;
  useAutoFilter: boolean;
  excludeBoards: string | null;
  maxPosts: number;
  resultCount: number;
  sheetSynced: number;
  errorMessage: string | null;
  createdAt: string;
};

type JobProgress = {
  updatedAt?: string;
  stage?: string;
  message?: string;
  cafeName?: string;
  cafeId?: string;
  cafeIndex?: number;
  cafeTotal?: number;
  keyword?: string;
  keywordIndex?: number;
  keywordTotal?: number;
  url?: string;
  urlIndex?: number;
  urlTotal?: number;
  candidates?: number;
  parseAttempts?: number;
  collected?: number;
  sheetSynced?: number;
  dbSynced?: number;
};

const EXCLUDE_BOARD_OPTIONS_STORAGE_KEY = "scrapeDashboardExcludeBoards:v1";
const SESSION_PANEL_OPEN_KEY = "scrapeDashboardSessionPanelOpen:v1";
const EXCLUDE_BOARD_OPTIONS_DEFAULT = [
  "도치맘 핫딜공구🔛",
  "광고",
  "홍보",
  "도치맘 핫딜공구",
  "공지",
];

const STAGE_ORDER: Record<string, number> = {
  QUEUED: 0,
  SEARCH: 1,
  PARSE: 2,
  DONE: 3,
  CANCELLED: 4,
  FAILED: 5,
};

const PIPELINE_STEPS = ["작업 생성", "검색 실행", "본문/댓글 파싱", "저장 및 연동"];

const PIPELINE_STEP_BY_STAGE: Record<string, number> = {
  QUEUED: 0,
  SEARCH: 1,
  PARSE: 2,
  DONE: 3,
  CANCELLED: 3,
  FAILED: 3,
};

const STAGE_LABELS: Record<string, string> = {
  SEARCH: "검색",
  PARSE: "본문/댓글 파싱",
  DONE: "저장 완료",
  CANCELLED: "중단됨",
  FAILED: "실패",
};

const JOB_STATUS_LABELS: Record<string, string> = {
  QUEUED: "실행 대기",
  RUNNING: "실행 중",
  SUCCESS: "성공",
  FAILED: "실패",
  CANCELLED: "중단됨",
};

function getStoredSessionPanelOpen() {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(SESSION_PANEL_OPEN_KEY);
    if (value === "1") return true;
    if (value === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function setStoredSessionPanelOpen(next: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_PANEL_OPEN_KEY, next ? "1" : "0");
  } catch {
    // localStorage 예외는 무시
  }
}

function getStageLabel(stage?: string) {
  const key = String(stage || "").toUpperCase();
  return STAGE_LABELS[key] || "대기/준비";
}

function getStageIndex(stage?: string) {
  const key = String(stage || "").toUpperCase();
  return STAGE_ORDER[key] ?? 0;
}

function getProgressPercent(stage?: string) {
  const key = String(stage || "").toUpperCase();
  if (key === "DONE") return 100;
  const idx = getStageIndex(key);
  if (idx <= 1) return Math.min(45, idx * 18 + 2);
  if (idx === 2) return 60;
  if (idx >= 3) return 100;
  return 8;
}

function getPipelineIndex(stage?: string) {
  const key = String(stage || "").toUpperCase();
  return PIPELINE_STEP_BY_STAGE[key] ?? 0;
}

function isFinishedStage(stage?: string) {
  const key = String(stage || "").toUpperCase();
  return key === "DONE" || key === "CANCELLED" || key === "FAILED";
}

function formatAgo(iso?: string) {
  if (!iso) return "-";
  const now = new Date();
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "-";
  const diffMs = Math.max(0, now.getTime() - t);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

function parseJsonList(input: string | null): string[] {
  if (!input) return [];
  try {
    return JSON.parse(input);
  } catch {
    return [];
  }
}

export default function DashboardPage() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [storageStateText, setStorageStateText] = useState("");
  const [savingSession, setSavingSession] = useState(false);
  const [isSessionOpen, setIsSessionOpen] = useState(true);

  const [cafes, setCafes] = useState<JoinedCafe[]>([]);
  const [cafesLoading, setCafesLoading] = useState(false);
  const [cafesError, setCafesError] = useState<string | null>(null);
  const [selectedCafeIds, setSelectedCafeIds] = useState<string[]>([]);

  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);

  const [keywords, setKeywords] = useState("");
  const [directUrlsText, setDirectUrlsText] = useState("");
  const [includeKeywordsText, setIncludeKeywordsText] = useState("");
  const [excludeKeywordsText, setExcludeKeywordsText] = useState("");
  const [datePreset, setDatePreset] = useState<"1m" | "3m" | "6m" | "1y" | "2y" | "all">("3m");
  const [excludeBoardCandidates, setExcludeBoardCandidates] = useState<string[]>(() => EXCLUDE_BOARD_OPTIONS_DEFAULT);
  const [selectedExcludeBoards, setSelectedExcludeBoards] = useState<string[]>([]);
  const [customExcludeBoard, setCustomExcludeBoard] = useState("");
  const [minViewCount, setMinViewCount] = useState("");
  const [minCommentCount, setMinCommentCount] = useState("");
  const [useAutoFilter, setUseAutoFilter] = useState(true);
  const [maxPosts, setMaxPosts] = useState(80);
  const [creating, setCreating] = useState(false);
  const [startingJobId, setStartingJobId] = useState<string | null>(null);
  const [progressByJobId, setProgressByJobId] = useState<Record<string, JobProgress | null>>({});
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);

  const jobStatusSummary = useMemo(() => {
    const total = jobs.length;
    const queue = jobs.filter((job) => job.status === "QUEUED").length;
    const running = jobs.filter((job) => job.status === "RUNNING").length;
    const success = jobs.filter((job) => job.status === "SUCCESS").length;
    const failed = jobs.filter((job) => job.status === "FAILED").length;
    const cancelled = jobs.filter((job) => job.status === "CANCELLED").length;
    return { total, queue, running, success, failed, cancelled };
  }, [jobs]);

  const activeJobs = useMemo(() => jobs.filter((job) => ["RUNNING", "QUEUED"].includes(job.status)), [jobs]);

  const getJobUiState = useCallback(
    (job: ScrapeJob) => {
      if (job.status === "RUNNING") {
        if (cancellingJobId === job.id) return { label: "중단 요청 중", disabled: true };
        return { label: "중단", disabled: false };
      }
      if (job.status === "QUEUED") {
        if (startingJobId === job.id) return { label: "실행 요청 중", disabled: true };
        return { label: "시작 대기", disabled: false };
      }
      if (startingJobId === job.id) return { label: "재실행 요청 중", disabled: true };
      return { label: "재실행", disabled: false };
    },
    [cancellingJobId, startingJobId]
  );

  const getStatusBadgeClass = useCallback((status: string) => {
    const key = String(status || "").toUpperCase();
    if (key === "RUNNING") return "bg-blue-100 text-blue-800";
    if (key === "QUEUED") return "bg-amber-100 text-amber-800";
    if (key === "SUCCESS") return "bg-emerald-100 text-emerald-800";
    if (key === "FAILED") return "bg-red-100 text-red-700";
    if (key === "CANCELLED") return "bg-slate-200 text-slate-700";
    return "bg-slate-100 text-slate-700";
  }, []);

  const keywordCount = useMemo(() => {
    const list = keywords
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return list.length;
  }, [keywords]);

  const directUrlCount = useMemo(() => {
    const list = directUrlsText
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
    return list.length;
  }, [directUrlsText]);

  const recommendedMaxPosts = useMemo(() => {
    // Practical default: keep jobs reasonably small to avoid timeouts / rate-limit.
    // Users can raise it, but we show a safe recommendation.
    if (selectedCafeIds.length === 0) return 80;
    if (keywordCount >= 200) return 30;
    if (keywordCount >= 80) return 50;
    if (keywordCount >= 30) return 60;
    return 80;
  }, [keywordCount, selectedCafeIds.length]);

  const normalizeExcludeBoardValue = useCallback((value: string) => value.trim().replace(/\s+/g, " "), []);

  const saveExcludeBoardsPreference = useCallback(
    (values: string[]) => {
      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(
          EXCLUDE_BOARD_OPTIONS_STORAGE_KEY,
          JSON.stringify(values)
        );
      } catch {
        // 브라우저 환경에서 localStorage 예외는 무시
      }
    },
    []
  );

  const addExcludeBoard = useCallback(
    (value: string) => {
      const next = normalizeExcludeBoardValue(value);
      if (!next) return;

      const lower = next.toLowerCase();
      const nextUnique = (prev: string[]) => {
        if (prev.some((item) => item.toLowerCase() === lower)) return prev;
        return [...prev, next];
      };

      setSelectedExcludeBoards((prev) => {
        const updated = nextUnique(prev);
        if (updated.length !== prev.length) {
          saveExcludeBoardsPreference(updated);
        }
        return updated;
      });

      setExcludeBoardCandidates((prev) => nextUnique(prev));
      setCustomExcludeBoard("");
    },
    [normalizeExcludeBoardValue, saveExcludeBoardsPreference]
  );

  const removeExcludeBoard = useCallback((value: string) => {
    const next = selectedExcludeBoards.filter((item) => item !== value);
    setSelectedExcludeBoards(next);
    saveExcludeBoardsPreference(next);
  }, [selectedExcludeBoards, saveExcludeBoardsPreference]);

  const computeDateRange = useCallback(
    (preset: "1m" | "3m" | "6m" | "1y" | "2y" | "all") => {
      if (preset === "all") return { fromDate: null as string | null, toDate: null as string | null };
      const now = new Date();
      const to = new Date(now);
      const from = new Date(now);
      if (preset === "1m") from.setMonth(from.getMonth() - 1);
      if (preset === "3m") from.setMonth(from.getMonth() - 3);
      if (preset === "6m") from.setMonth(from.getMonth() - 6);
      if (preset === "1y") from.setFullYear(from.getFullYear() - 1);
      if (preset === "2y") from.setFullYear(from.getFullYear() - 2);

      const asYmd = (d: Date) => {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
      };

      return { fromDate: asYmd(from), toDate: asYmd(to) };
    },
    []
  );

  const selectedCafes = useMemo(
    () => cafes.filter((cafe) => selectedCafeIds.includes(cafe.cafeId)),
    [cafes, selectedCafeIds]
  );

  const fetchSession = useCallback(async () => {
    try {
      setSessionLoading(true);
      const res = await fetch("/api/session");
      const data = await res.json();
      if (data.success) {
        setSession(data.data);
        const userPreference = getStoredSessionPanelOpen();
        if (userPreference === null) {
          setIsSessionOpen(!data.data?.hasSession);
        }
      } else {
        const userPreference = getStoredSessionPanelOpen();
        if (userPreference === null) {
          setIsSessionOpen(true);
        }
      }
    } finally {
      setSessionLoading(false);
    }
  }, []);

  const toggleSessionPanel = useCallback((next: boolean) => {
    setIsSessionOpen(next);
    setStoredSessionPanelOpen(next);
  }, []);

  useEffect(() => {
    const preferred = getStoredSessionPanelOpen();
    if (preferred !== null) {
      setIsSessionOpen(preferred);
    }
  }, []);

  const saveSession = async () => {
    if (!storageStateText.trim()) {
      alert("storageState(JSON) 내용을 붙여 넣으세요.");
      return;
    }
    try {
      setSavingSession(true);
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageState: storageStateText }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || "세션 저장 실패");
        return;
      }
      setStorageStateText("");
      toggleSessionPanel(false);
      await fetchSession();
      alert("세션 저장 완료");
    } finally {
      setSavingSession(false);
    }
  };

  const deleteSession = async () => {
    if (!confirm("저장된 세션을 삭제할까요?")) return;
    const res = await fetch("/api/session", { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || !data.success) {
      alert(data.error || "세션 삭제 실패");
      return;
    }
    toggleSessionPanel(true);
    await fetchSession();
    alert("세션 삭제 완료");
  };

  const fetchJobs = useCallback(async () => {
    try {
      setJobsLoading(true);
      const res = await fetch("/api/scrape-jobs");
      const data = await res.json();
      if (data.success) setJobs(data.data);
    } finally {
      setJobsLoading(false);
    }
  }, []);

  const fetchProgress = useCallback(async (jobId: string) => {
    const res = await fetch(`/api/scrape-jobs/${jobId}/progress`);
    const data = await res.json();
    if (!res.ok || !data.success) return;
    const progress = data?.data?.progress || null;
    setProgressByJobId((prev) => ({ ...prev, [jobId]: progress }));
  }, []);

  const cancelJob = async (jobId: string) => {
    try {
      setCancellingJobId(jobId);
      const res = await fetch(`/api/scrape-jobs/${jobId}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || "중단 요청 실패");
        return;
      }
      alert("중단 요청을 등록했습니다. Worker가 안전하게 종료합니다.");
    } finally {
      setCancellingJobId(null);
    }
  };

  // Keep session status synced with short polling so session changes in another device/window appear immediately.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await fetchSession();
    };

    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [fetchSession]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await fetchJobs();
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [fetchJobs]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(EXCLUDE_BOARD_OPTIONS_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const normalized = parsed
        .map((v) => {
          if (typeof v !== "string") return "";
          return normalizeExcludeBoardValue(v);
        })
        .filter(Boolean);
      if (normalized.length === 0) return;

      setSelectedExcludeBoards(normalized);
      setExcludeBoardCandidates((prev) => {
        const merged = [...prev];
        const existing = new Set(merged.map((item) => item.toLowerCase()));
        for (const value of normalized) {
          const key = value.toLowerCase();
          if (!existing.has(key)) {
            merged.push(value);
            existing.add(key);
          }
        }
        return merged;
      });
      saveExcludeBoardsPreference(normalized);
    } catch {
      // ignore
    }
  }, [normalizeExcludeBoardValue, saveExcludeBoardsPreference]);

  useEffect(() => {
    const running = jobs.filter((j) => j.status === "RUNNING");
    if (running.length === 0) return;

    let alive = true;
    const tick = async () => {
      for (const j of running) {
        if (!alive) return;
        await fetchProgress(j.id);
      }
    };

    tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [jobs, fetchProgress]);

  const fetchCafes = async () => {
    try {
      setCafesLoading(true);
      setCafesError(null);
      const res = await fetch("/api/cafes");
      const data = await res.json();
      if (!res.ok || !data.success) {
        setCafes([]);
        setSelectedCafeIds([]);
        setCafesError(data.error || "가입 카페 조회 실패");
        return;
      }
      const list = Array.isArray(data.data) ? data.data : [];
      setCafes(list);
      setSelectedCafeIds([]);
      if (list.length === 0) {
        setCafesError("가입 카페 목록이 비어있습니다. Worker가 갱신하기 전일 수 있습니다.");
      }
    } finally {
      setCafesLoading(false);
    }
  };

  const toggleCafe = (cafeId: string) => {
    setSelectedCafeIds((prev) =>
      prev.includes(cafeId) ? prev.filter((id) => id !== cafeId) : [...prev, cafeId]
    );
  };

  const startJob = async (jobId: string) => {
    try {
      setStartingJobId(jobId);
      const res = await fetch(`/api/scrape-jobs/${jobId}/start`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || "작업 시작 실패");
        return;
      }
      fetchJobs();
      alert("작업을 시작했습니다. 서버에서 계속 진행됩니다.");
    } finally {
      setStartingJobId(null);
    }
  };

  const handleCreateJob = async () => {
    if (!keywords.trim() && !directUrlsText.trim()) {
      alert("키워드(쉼표 구분) 또는 직접 URL(줄바꿈)을 입력하세요.");
      return;
    }
    if (selectedCafes.length === 0) {
      alert("스크랩할 카페를 선택하세요.");
      return;
    }

    try {
      setCreating(true);
      const { fromDate, toDate } = computeDateRange(datePreset);
      const res = await fetch("/api/scrape-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords,
          directUrls: directUrlsText,
          includeKeywords: includeKeywordsText.split(",").map((v) => v.trim()).filter(Boolean),
          excludeKeywords: excludeKeywordsText.split(",").map((v) => v.trim()).filter(Boolean),
          excludeBoards: selectedExcludeBoards.map((board) => normalizeExcludeBoardValue(board)).filter(Boolean),
          fromDate,
          toDate,
          minViewCount: minViewCount === "" ? null : Number(minViewCount),
          minCommentCount: minCommentCount === "" ? null : Number(minCommentCount),
          useAutoFilter,
          maxPosts,
          selectedCafes,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || "작업 생성 실패");
        return;
      }

      await fetchJobs();
      await startJob(data.data.id);
    } finally {
      setCreating(false);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  return (
    <main className="min-h-screen bg-slate-100 p-4 md:p-8 text-black">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="bg-white border border-slate-200 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-black">카페 아카이빙 대시보드</h1>
            <p className="text-sm text-black">열람 가능한 글을 조건 기반으로 아카이빙하고 Google Sheets로 보냅니다.</p>
          </div>
          <button onClick={handleLogout} className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg">
            로그아웃
          </button>
        </header>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <h2 className="text-lg font-semibold text-black">작업 처리 파이프라인</h2>
          <p className="text-sm text-slate-600">
            Next.js(App Router) 웹에서 작업 등록/조회, 별도 Node Worker에서 큐 실행, Playwright로 크롤링한 뒤 Prisma + Google Sheets로 저장합니다.
          </p>
          <ol className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2 text-sm">
            {PIPELINE_STEPS.map((label, index) => (
              <li key={label} className="border border-slate-200 rounded-lg p-2 text-slate-700 bg-slate-50">
                {index + 1}. {label}
              </li>
            ))}
          </ol>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-black">현재 진행 상태</h2>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <div className="border border-slate-200 rounded-xl p-3">
              <p className="text-xs text-slate-600">전체</p>
              <p className="text-xl font-bold text-black">{jobStatusSummary.total}</p>
            </div>
            <div className="border border-slate-200 rounded-xl p-3">
              <p className="text-xs text-slate-600">대기</p>
              <p className="text-xl font-bold text-black">{jobStatusSummary.queue}</p>
            </div>
            <div className="border border-slate-200 rounded-xl p-3">
              <p className="text-xs text-slate-600">실행</p>
              <p className="text-xl font-bold text-black">{jobStatusSummary.running}</p>
            </div>
            <div className="border border-slate-200 rounded-xl p-3">
              <p className="text-xs text-slate-600">성공</p>
              <p className="text-xl font-bold text-black">{jobStatusSummary.success}</p>
            </div>
            <div className="border border-slate-200 rounded-xl p-3">
              <p className="text-xs text-slate-600">실패</p>
              <p className="text-xl font-bold text-black">{jobStatusSummary.failed}</p>
            </div>
            <div className="border border-slate-200 rounded-xl p-3">
              <p className="text-xs text-slate-600">중단</p>
              <p className="text-xl font-bold text-black">{jobStatusSummary.cancelled}</p>
            </div>
          </div>

              <div className="space-y-3">
                <p className="text-sm font-semibold text-black">실행/대기 중 작업</p>
                {activeJobs.length === 0 ? (
                  <p className="text-sm text-slate-600">현재 실행/대기 중인 작업이 없습니다.</p>
                ) : (
                  <div className="space-y-3">
                    {activeJobs.map((job) => {
                      const isRunning = job.status === "RUNNING";
                      const p = isRunning ? (progressByJobId[job.id] || null) : null;
                      const action = getJobUiState(job);
                      const progressText = isRunning
                        ? [
                            p?.stage ? `단계: ${getStageLabel(p.stage)}` : "단계: 대기",
                            p?.cafeName ? `카페: ${p.cafeName}` : null,
                            p?.keyword ? `키워드: ${p.keyword}` : null,
                            p?.candidates ? `후보: ${p.candidates}` : null,
                            p?.collected !== undefined ? `수집: ${p.collected}` : null,
                            p?.dbSynced !== undefined ? `DB: ${p.dbSynced}` : null,
                            p?.sheetSynced !== undefined ? `시트: ${p.sheetSynced}` : null,
                            p?.message ? `메시지: ${p.message}` : null,
                          ]
                            .filter(Boolean)
                            .join(" / ")
                        : "큐에서 실행 대기";
                      const percent = isRunning ? getProgressPercent(p?.stage) : 15;
                      const updatedAt = p?.updatedAt ? formatAgo(p.updatedAt) : "업데이트 없음";
                      const stepIndex = isRunning ? getPipelineIndex(p?.stage) : 1;
                      const statusKey = String(job.status || "").toUpperCase();

                      return (
                        <div key={job.id} className="border border-slate-200 rounded-lg p-3">
                          <div className="flex flex-wrap items-center gap-2 mb-2">
                            <p className="font-semibold text-black">{new Date(job.createdAt).toLocaleString("ko-KR")}</p>
                            <span className={`text-xs px-2 py-1 rounded-full ${getStatusBadgeClass(job.status)}`}>
                              {JOB_STATUS_LABELS[statusKey] || statusKey || "대기"}
                            </span>
                            <span className="text-xs text-slate-600">업데이트: {updatedAt}</span>
                            <span className="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded-full">
                              {action.label}
                            </span>
                            {isRunning ? (
                              <button
                                onClick={() => cancelJob(job.id)}
                                disabled={action.disabled && cancellingJobId === job.id}
                                className="px-2 py-1 text-xs bg-red-600 text-white rounded disabled:opacity-50"
                              >
                                {action.label}
                              </button>
                            ) : (
                              <button
                                onClick={() => cancelJob(job.id)}
                                disabled={action.disabled && cancellingJobId === job.id}
                                className="px-2 py-1 text-xs bg-red-600 text-white rounded disabled:opacity-50"
                              >
                                {action.label === "시작 대기" ? "대기 취소" : "중단"}
                              </button>
                            )}
                          </div>
                          <p className="text-sm text-black truncate" title={progressText}>
                            {progressText || "-"}
                          </p>
                          <div className="mt-2 flex gap-2">
                            {PIPELINE_STEPS.map((step, idx) => {
                              const active = idx <= stepIndex;
                              const isCurrent = isRunning ? idx === stepIndex && !isFinishedStage(p?.stage) : false;
                              return (
                                <span
                                  key={step}
                                  className={`text-xs px-2 py-1 rounded-full border ${
                                    active
                                      ? isCurrent
                                        ? "bg-blue-100 border-blue-300 text-blue-800"
                                        : "bg-emerald-100 border-emerald-300 text-emerald-800"
                                      : "bg-slate-100 border-slate-200 text-slate-500"
                                  }`}
                                >
                                  {idx + 1}. {step}
                                </span>
                              );
                            })}
                          </div>
                          <div className="mt-2">
                            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className="h-2 bg-emerald-500 transition-all"
                                style={{ width: `${Math.min(100, percent)}%` }}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5">
          <h2 className="text-lg font-semibold text-black">1) 카페 세션 확인</h2>
          <div className="flex items-center justify-between mt-1">
            <p className="text-sm text-black">
              {sessionLoading
                ? "세션 확인 중..."
                : session?.hasSession
                  ? `세션 사용 가능 (${session.lastChecked ? new Date(session.lastChecked).toLocaleString("ko-KR") : "시간 정보 없음"})`
                  : "세션 없음 (아래에 storageState JSON 업로드 필요)"}
            </p>
            <button
              onClick={() => toggleSessionPanel(!isSessionOpen)}
              className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700"
            >
              {isSessionOpen ? "접기" : "재입력/수정"}
            </button>
          </div>
          {isSessionOpen && (
            <div className="mt-4 space-y-2">
              <p className="text-xs text-black">
                Worker가 네이버에 로그인된 상태로 접속하려면 Playwright storageState(JSON)가 필요합니다.
                1회 생성 후 아래에 붙여넣고 저장하세요.
              </p>
              <textarea
                value={storageStateText}
                onChange={(e) => setStorageStateText(e.target.value)}
                placeholder='여기에 storageState JSON 전체를 붙여넣기 (예: {"cookies":[...],"origins":[...]})'
                className="w-full h-40 p-3 border border-slate-200 rounded-lg text-xs font-mono text-black"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={saveSession}
                  disabled={savingSession}
                  className="px-3 py-2 bg-slate-900 text-white rounded-lg text-sm disabled:opacity-50"
                >
                  {savingSession ? "저장 중..." : "세션 저장"}
                </button>
                <button
                  onClick={deleteSession}
                  className="px-3 py-2 bg-slate-200 text-slate-900 rounded-lg text-sm"
                >
                  세션 삭제
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-black">2) 카페 선택</h2>
            <button onClick={fetchCafes} disabled={cafesLoading} className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">
              {cafesLoading ? "불러오는 중..." : "가입 카페 불러오기"}
            </button>
          </div>

          {cafesError && <p className="text-sm text-red-600 mt-3">{cafesError}</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4 max-h-72 overflow-y-auto">
            {cafes.map((cafe) => {
              const checked = selectedCafeIds.includes(cafe.cafeId);
              return (
                <label key={cafe.cafeId} className={`border rounded-lg p-3 cursor-pointer ${checked ? "border-blue-500 bg-blue-50" : "border-slate-200"}`}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={checked} onChange={() => toggleCafe(cafe.cafeId)} className="mt-1" />
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 truncate">{cafe.name}</p>
                      <p className="text-xs text-black truncate">{cafe.url}</p>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-black">3) 실행 조건</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="text-sm text-slate-700">키워드 목록 (쉼표 구분, 공백 자동 제거)</label>
              <textarea
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg min-h-[88px] text-black"
                placeholder="공구,미개봉,한정판"
              />
              <div className="mt-1 text-xs text-slate-600">키워드 개수: {keywordCount}개</div>
            </div>

            <div className="md:col-span-2">
              <label className="text-sm text-slate-700">직접 URL 목록 (줄바꿈 구분, 선택)</label>
              <textarea
                value={directUrlsText}
                onChange={(e) => setDirectUrlsText(e.target.value)}
                className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg min-h-[88px] font-mono text-xs text-black"
                placeholder={"예)\nhttps://cafe.naver.com/ArticleRead.nhn?clubid=...&articleid=...\nhttps://cafe.naver.com/ca-fe/cafes/.../articles/..."}
              />
              <div className="mt-1 text-xs text-slate-600">URL 개수: {directUrlCount}개 (입력 시 검색 대신 이 URL만 스크랩)</div>
            </div>

            <div>
              <label className="text-sm text-slate-700">포함 단어</label>
              <input value={includeKeywordsText} onChange={(e) => setIncludeKeywordsText(e.target.value)} className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg text-black" placeholder="정품,직거래" />
            </div>

            <div>
              <label className="text-sm text-slate-700">제외 단어</label>
              <input value={excludeKeywordsText} onChange={(e) => setExcludeKeywordsText(e.target.value)} className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg text-black" placeholder="판매완료,홍보" />
            </div>

            <div>
              <label className="text-sm text-slate-700">제외 게시판 (드롭다운에서 선택, 수동 입력 가능)</label>
              <div className="mt-1 grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-2">
                <select
                  value=""
                  onChange={(e) => {
                    const value = e.target.value;
                    if (!value) return;
                    addExcludeBoard(value);
                    (e.target as HTMLSelectElement).value = "";
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-black bg-white"
                >
                  <option value="">게시판 선택</option>
                  {excludeBoardCandidates
                    .filter((candidate) => !selectedExcludeBoards.includes(candidate))
                    .map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {candidate}
                      </option>
                    ))}
                </select>

                <div className="flex gap-2">
                  <input
                    value={customExcludeBoard}
                    onChange={(e) => setCustomExcludeBoard(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      addExcludeBoard(customExcludeBoard);
                    }}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-black"
                    placeholder="예) 광고게시판, 핫딜공구"
                  />
                  <button
                    type="button"
                    onClick={() => addExcludeBoard(customExcludeBoard)}
                    className="px-3 py-2 text-sm bg-slate-900 text-white rounded-lg"
                  >
                    추가
                  </button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {selectedExcludeBoards.length === 0 ? (
                  <span className="text-xs text-slate-600">선택된 제외 게시판이 없습니다.</span>
                ) : (
                  selectedExcludeBoards.map((board) => (
                    <span
                      key={board}
                      className="inline-flex items-center gap-2 px-2 py-1 text-xs bg-slate-100 text-slate-700 rounded-full"
                    >
                      {board}
                      <button
                        type="button"
                        onClick={() => removeExcludeBoard(board)}
                        className="text-slate-500 hover:text-red-600"
                        aria-label={`${board} 제거`}
                      >
                        ✕
                      </button>
                    </span>
                  ))
                )}
              </div>
              <div className="mt-1 text-xs text-slate-600">
                입력 시 해당 게시판 글을 검색 후보에서 미리 제외합니다.
              </div>
            </div>

            <div>
              <label className="text-sm text-slate-700">최소 조회수</label>
              <input type="number" min={0} value={minViewCount} onChange={(e) => setMinViewCount(e.target.value)} className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg text-black" />
            </div>

            <div>
              <label className="text-sm text-slate-700">최소 댓글수</label>
              <input type="number" min={0} value={minCommentCount} onChange={(e) => setMinCommentCount(e.target.value)} className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg text-black" />
            </div>

            <div>
              <label className="text-sm text-slate-700">기간</label>
                <select
                  value={datePreset}
                  onChange={(e) =>
                    setDatePreset(
                      e.target.value as "1m" | "3m" | "6m" | "1y" | "2y" | "all"
                    )
                  }
                  className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg bg-white text-black"
                >
                <option value="1m">최근 1개월</option>
                <option value="3m">최근 3개월</option>
                <option value="6m">최근 6개월</option>
                <option value="1y">최근 1년</option>
                <option value="2y">최근 2년</option>
                <option value="all">전체 (기간 제한 없음)</option>
              </select>
              <div className="mt-1 text-xs text-slate-600">
                {(() => {
                  const r = computeDateRange(datePreset);
                  if (!r.fromDate || !r.toDate) return "기간 제한 없음";
                  return `${r.fromDate} ~ ${r.toDate}`;
                })()}
              </div>
            </div>

            <div>
              <label className="text-sm text-slate-700">최대 수집 글 수</label>
              <input type="number" min={1} max={300} value={maxPosts} onChange={(e) => setMaxPosts(Number(e.target.value) || 80)} className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg text-black" />
              <div className="mt-1 text-xs text-slate-600">
                권장: {recommendedMaxPosts} (절대 상한: 300). 키워드/카페가 많으면 낮게 잡는 게 안정적입니다.
              </div>
            </div>

            <div className="flex items-center gap-2 mt-7">
              <input id="autoFilter" type="checkbox" checked={useAutoFilter} onChange={(e) => setUseAutoFilter(e.target.checked)} />
              <label htmlFor="autoFilter" className="text-sm text-slate-700">카페별 자동 임계치 사용</label>
            </div>
          </div>

          <div className="text-sm text-slate-600">선택 카페: {selectedCafes.length}개</div>

          <button onClick={handleCreateJob} disabled={creating} className="px-4 py-2 bg-emerald-600 text-white rounded-lg disabled:opacity-50">
            {creating ? "등록/시작 중..." : "작업 등록 후 즉시 실행"}
          </button>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5">
          <h2 className="text-lg font-semibold text-black mb-4">최근 작업</h2>
          {jobsLoading ? (
            <p className="text-sm text-black">불러오는 중...</p>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-black">등록된 작업이 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-black">
                    <th className="text-left py-2">생성일</th>
                    <th className="text-left py-2">키워드</th>
                    <th className="text-left py-2">카페</th>
                    <th className="text-left py-2">필터</th>
                    <th className="text-left py-2">진행</th>
                    <th className="text-left py-2">결과</th>
                    <th className="text-left py-2">상태</th>
                    <th className="text-left py-2">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => {
                    const keywordText = parseJsonList(job.keywords).join(", ");
                    const cafeText = parseJsonList(job.cafeNames).join(", ");
                    const filterText = job.useAutoFilter
                      ? "AUTO"
                      : `조회 ${job.minViewCount ?? 0}+ / 댓글 ${job.minCommentCount ?? 0}+`;
                    const excludedBoards = parseJsonList(job.excludeBoards);
                    const boardFilterText =
                      excludedBoards.length > 0 ? ` / 제외게시판 ${excludedBoards.length}개` : "";

                    const p = progressByJobId[job.id] || null;
                    const runningResult = job.status === "RUNNING" && p
                      ? `DB ${p?.dbSynced ?? 0} / Sheet ${p?.sheetSynced ?? 0}`
                      : `DB ${job.resultCount} / Sheet ${job.sheetSynced}`;
                    const queuedPositionText = (() => {
                      if (job.status !== "QUEUED") return null;
                      const queued = jobs
                        .filter((j) => j.status === "QUEUED")
                        .slice()
                        .sort(
                          (a, b) =>
                            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                        );
                      const idx = queued.findIndex((j) => j.id === job.id);
                      if (idx < 0) return "대기중";
                      return idx === 0 ? "대기중 (다음 순서)" : `대기중 (앞에 ${idx}개)`;
                    })();

                      const progressText = (() => {
                        if (job.status === "RUNNING") {
                        return [
                          p?.stage ? `단계:${p.stage}` : null,
                          p?.cafeName ? `카페:${p.cafeName}` : p?.cafeId ? `카페:${p.cafeId}` : null,
                          p?.cafeIndex && p?.cafeTotal ? `(${p.cafeIndex}/${p.cafeTotal})` : null,
                          p?.keyword ? `키워드:${p.keyword}` : null,
                          p?.keywordIndex && p?.keywordTotal ? `(${p.keywordIndex}/${p.keywordTotal})` : null,
                          p?.url ? `URL:${String(p.url).slice(0, 30)}…` : null,
                          typeof p?.parseAttempts === "number" ? `파싱:${p.parseAttempts}` : null,
                          typeof p?.collected === "number" ? `수집:${p.collected}` : null,
                        ]
                            .filter(Boolean)
                            .join(" ");
                      }
                        if (job.status === "QUEUED") return queuedPositionText || "-";
                        return "-";
                      })();
                      const action = getJobUiState(job);
                      const jobStatusText = JOB_STATUS_LABELS[String(job.status || "").toUpperCase()] || job.status;

                      return (
                        <tr key={job.id} className="border-b border-slate-100">
                          <td className="py-2">{new Date(job.createdAt).toLocaleString("ko-KR")}</td>
                        <td className="py-2 max-w-[180px] truncate" title={keywordText}>{keywordText}</td>
                        <td className="py-2 max-w-[180px] truncate" title={cafeText}>{cafeText}</td>
                        <td className="py-2">{filterText}{boardFilterText}</td>
                        <td className="py-2 max-w-[260px] truncate" title={progressText}>{progressText}</td>
                        <td className="py-2">{runningResult}</td>
                          <td className="py-2">
                            <span className={`text-xs px-2 py-1 rounded-full ${getStatusBadgeClass(job.status)}`}>
                              {jobStatusText}
                            </span>
                          </td>
                          <td className="py-2">
                            {job.status === "RUNNING" ? (
                              <button
                                onClick={() => cancelJob(job.id)}
                                disabled={action.disabled && cancellingJobId === job.id}
                                className="px-2 py-1 text-xs bg-red-600 text-white rounded disabled:opacity-50"
                              >
                                {action.label}
                              </button>
                            ) : job.status === "QUEUED" ? (
                              <button
                                onClick={() => cancelJob(job.id)}
                                disabled={action.disabled && cancellingJobId === job.id}
                                className="px-2 py-1 text-xs bg-red-600 text-white rounded disabled:opacity-50"
                              >
                                {action.label === "시작 대기" ? "대기 취소" : action.label}
                              </button>
                            ) : (
                              <button
                                onClick={() => startJob(job.id)}
                                disabled={action.disabled}
                                className="px-2 py-1 text-xs bg-slate-800 text-white rounded disabled:opacity-50"
                              >
                                {action.label}
                              </button>
                            )}
                          {job.errorMessage && <p className="text-xs text-red-600 mt-1">{job.errorMessage}</p>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
