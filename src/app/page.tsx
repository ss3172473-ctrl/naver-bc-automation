"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SessionInfo = {
  hasSession: boolean;
  updatedAt: string | null;
};

type JoinedCafe = {
  cafeId: string;
  name: string;
  url: string;
};

type VersionInfo = {
  sha: string | null;
  now: string;
  vercelUrl: string | null;
  deploymentId: string | null;
};

type WorkerHeartbeat = {
  at: string;
  status: string;
  commit: string | null;
  branch?: string | null;
  service?: string | null;
  env?: string | null;
  jobId?: string | null;
  running?: number;
};

type ScrapeJob = {
  id: string;
  status: string;
  createdAt: string;
  keywords: string;
  cafeIds: string;
  cafeNames: string | null;
  fromDate: string | null;
  toDate: string | null;
  minViewCount: number | null;
  minCommentCount: number | null;
  maxPosts: number;
  resultCount: number | null;
  sheetSynced: number | null;
  errorMessage: string | null;
};

type JobProgressCell = {
  cafeId: string;
  cafeName: string;
  keyword: string;
  status: string; // searching | parsing | done | failed | skipped
  pagesScanned?: number;
  pagesTarget?: number;
  perPage?: number;
  fetchedRows?: number;
  searched?: number; // back-compat
  totalResults?: number;
  collected?: number;
  skipped?: number;
  filteredOut?: number;
  updatedAt?: string;
};

type JobProgress = {
  stage?: string;
  cafeId?: string;
  cafeName?: string;
  keyword?: string;
  message?: string;
  collected?: number;
  dbSynced?: number;
  sheetSynced?: number;
  updatedAt?: string;
  keywordMatrix?: Record<string, JobProgressCell>;
};

const SESSION_PANEL_OPEN_KEY = "naverCafeSessionPanelOpen:v1";

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function parseJsonList(input: string | null): string[] {
  if (!input) return [];
  const parsed = safeJsonParse<unknown>(input);
  return Array.isArray(parsed) ? parsed.map((v) => String(v || "")) : [];
}

function makePairKey(cafeId: string, keyword: string) {
  // Must match Worker keying: lowercased cafeId + keyword.
  return `${String(cafeId || "").trim().toLowerCase()}::${String(keyword || "").trim().toLowerCase()}`;
}

function shortSha(input?: string | null) {
  const s = String(input || "").trim();
  if (!s) return "-";
  return s.slice(0, 7);
}

function formatAgo(iso?: string) {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "-";
  const diffMs = Math.max(0, Date.now() - t);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}

function shortenCafeName(name: string, max = 15) {
  const s = String(name || "");
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

function normalizeKeyword(input: string) {
  // Keep Korean/English as-is, just normalize spaces.
  return String(input || "").trim().replace(/\s+/g, "");
}

function uniq<T>(arr: T[]) {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const k = String(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function computeDateRange(preset: "1m" | "3m" | "6m" | "1y" | "2y" | "all") {
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
}

function keywordToQueryString(keywords: string[]) {
  return keywords.join(", ");
}

function resolveDisplayStatus(jobStatus: string, progress: JobProgress | null): "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED" {
  const js = String(jobStatus || "").toUpperCase();
  if (js === "RUNNING") return "RUNNING";
  if (js === "QUEUED") return "QUEUED";
  if (js === "SUCCESS" || js === "DONE") return "SUCCESS";
  if (js === "FAILED") return "FAILED";
  if (js === "CANCELLED") return "CANCELLED";
  // Worker sometimes writes stage when job row isn't updated yet.
  const st = String(progress?.stage || "").toUpperCase();
  if (st === "DONE") return "SUCCESS";
  if (st === "FAILED") return "FAILED";
  if (st === "CANCELLED") return "CANCELLED";
  if (st) return "RUNNING";
  return "QUEUED";
}

function cellStatusLabel(cell: JobProgressCell | null, jobStatus: "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED", isCurrent: boolean) {
  if (cell) {
    const s = String(cell.status || "").toLowerCase();
    if (s === "done") return "완료";
    if (s === "failed") return "실패";
    if (s === "skipped") return "스킵";
    if (s === "parsing") return "파싱";
    if (s === "searching") return isCurrent ? "실행" : "대기";
    return isCurrent ? "실행" : "대기";
  }
  if (jobStatus === "SUCCESS") return "완료";
  if (jobStatus === "FAILED") return "실패";
  if (jobStatus === "CANCELLED") return "중단";
  if (jobStatus === "RUNNING") return isCurrent ? "실행" : "대기";
  return "대기";
}

function cellMetaLine(cell: JobProgressCell | null) {
  if (!cell) return "-";
  const t = Number(cell.totalResults ?? 0) || 0;
  const c = Number(cell.collected ?? 0) || 0;
  const s = Number(cell.skipped ?? 0) || 0;
  const f = Number(cell.filteredOut ?? 0) || 0;
  return `후보 ${t} / 수집 ${c} / 스킵 ${s} / 필터 ${f}`;
}

function cellPagesLine(cell: JobProgressCell | null) {
  if (!cell) return "";
  const scanned = Number(cell.pagesScanned ?? 0) || 0;
  const target = Number(cell.pagesTarget ?? 0) || 0;
  const fetched =
    typeof cell.fetchedRows === "number"
      ? cell.fetchedRows
      : (typeof cell.searched === "number" ? cell.searched : null);
  if (target > 0) return `페이지 ${scanned}/${target}${fetched !== null ? ` (fetched ${fetched})` : ""}`;
  if (fetched !== null) return `fetched ${fetched}`;
  return "";
}

function getStoredSessionPanelOpen(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(SESSION_PANEL_OPEN_KEY);
    if (v === null) return null;
    return v === "1";
  } catch {
    return null;
  }
}

function setStoredSessionPanelOpen(open: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_PANEL_OPEN_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
}

function KeywordInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const addTokens = useCallback(
    (raw: string) => {
      const tokens = raw
        .split(",")
        .map((t) => normalizeKeyword(t))
        .filter(Boolean);
      if (tokens.length === 0) return;
      onChange(uniq([...value, ...tokens]));
    },
    [value, onChange]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTokens(draft);
      setDraft("");
    }
    if (e.key === "Backspace" && draft.trim() === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const removeToken = (token: string) => {
    onChange(value.filter((v) => v !== token));
  };

  return (
    <div className="border border-slate-200 rounded-lg p-2 bg-white">
      <div className="flex flex-wrap gap-2">
        {value.map((kw) => (
          <button
            key={kw}
            type="button"
            onClick={() => removeToken(kw)}
            className="px-2 py-1 text-sm rounded-full bg-slate-900 text-white"
            title="클릭하면 삭제"
          >
            #{kw}
          </button>
        ))}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="키워드 입력 후 Enter (또는 ,)"
          className="flex-1 min-w-[220px] px-2 py-1 text-sm outline-none text-black"
        />
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="px-2 py-1 text-xs rounded bg-slate-100 text-slate-700"
          onClick={() => {
            addTokens(draft);
            setDraft("");
            inputRef.current?.focus();
          }}
        >
          추가
        </button>
        <button
          type="button"
          className="px-2 py-1 text-xs rounded bg-slate-100 text-slate-700"
          onClick={() => {
            setDraft("");
            onChange([]);
            inputRef.current?.focus();
          }}
        >
          전체삭제
        </button>
        <span className="px-2 py-1 text-xs text-slate-600">키워드 개수: {value.length}</span>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [isSessionOpen, setIsSessionOpen] = useState(true);
  const [storageStateText, setStorageStateText] = useState("");
  const [savingSession, setSavingSession] = useState(false);

  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [workerHeartbeat, setWorkerHeartbeat] = useState<WorkerHeartbeat | null>(null);

  const [cafes, setCafes] = useState<JoinedCafe[]>([]);
  const [cafesLoading, setCafesLoading] = useState(false);
  const [cafesError, setCafesError] = useState<string | null>(null);
  const [selectedCafeIds, setSelectedCafeIds] = useState<string[]>([]);

  const [keywords, setKeywords] = useState<string[]>([]);
  const [datePreset, setDatePreset] = useState<"1m" | "3m" | "6m" | "1y" | "2y" | "all">("1y");
  const [minViewCount, setMinViewCount] = useState<string>("100");
  const [minCommentCount, setMinCommentCount] = useState<string>("5");
  const [maxPostsTotal, setMaxPostsTotal] = useState<string>(""); // keep blank by default
  const [creating, setCreating] = useState(false);

  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [progressByJobId, setProgressByJobId] = useState<Record<string, JobProgress | null>>({});
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);

  useEffect(() => {
    const stored = getStoredSessionPanelOpen();
    if (stored !== null) {
      setIsSessionOpen(stored);
    }
  }, []);

  const fetchSession = useCallback(async () => {
    try {
      setSessionLoading(true);
      const res = await fetch("/api/session");
      const data = await res.json();
      if (data?.success) {
        setSession(data.data);
        const userPref = getStoredSessionPanelOpen();
        if (userPref === null) {
          setIsSessionOpen(!data.data?.hasSession);
        }
      }
    } finally {
      setSessionLoading(false);
    }
  }, []);

  const fetchCafes = useCallback(async () => {
    try {
      setCafesLoading(true);
      setCafesError(null);
      const res = await fetch("/api/cafes");
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setCafes([]);
        setSelectedCafeIds([]);
        setCafesError(data?.error || "가입 카페 조회 실패");
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
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      setJobsLoading(true);
      const res = await fetch("/api/scrape-jobs");
      const data = await res.json();
      if (data?.success) setJobs(data.data);
    } finally {
      setJobsLoading(false);
    }
  }, []);

  const fetchProgress = useCallback(async (jobId: string) => {
    const res = await fetch(`/api/scrape-jobs/${jobId}/progress`);
    const data = await res.json();
    if (!res.ok || !data?.success) return;
    setProgressByJobId((prev) => ({ ...prev, [jobId]: data?.data?.progress || null }));
  }, []);

  useEffect(() => {
    fetchSession();
    fetchJobs();
  }, [fetchSession, fetchJobs]);

  const fetchVersion = useCallback(async () => {
    const res = await fetch("/api/version", { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) return;
    setVersionInfo(data.data || null);
  }, []);

  const fetchWorker = useCallback(async () => {
    const res = await fetch("/api/worker-status", { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) return;
    setWorkerHeartbeat(data.data || null);
  }, []);

  useEffect(() => {
    fetchVersion();
    fetchWorker();
  }, [fetchVersion, fetchWorker]);

  // Poll worker heartbeat so it's obvious whether Railway is alive and which commit is running.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await fetchWorker();
    };
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [fetchWorker]);

  // Poll jobs list (status/resultCount) so UI doesn't look stuck.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      await fetchJobs();
    };
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [fetchJobs]);

  // Poll progress for recent active/queued jobs.
  const trackedJobs = useMemo(() => {
    const recent = jobs
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);
    return recent.filter((j) => {
      const p = progressByJobId[j.id] || null;
      const st = resolveDisplayStatus(j.status, p);
      return st === "RUNNING" || st === "QUEUED";
    });
  }, [jobs, progressByJobId]);

  useEffect(() => {
    if (trackedJobs.length === 0) return;
    let alive = true;
    const tick = async () => {
      for (const j of trackedJobs) {
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
  }, [trackedJobs, fetchProgress]);

  // Create a "batch" = last created set of per-cafe jobs within 10 minutes, with same keywords/date/filter signature.
  const latestBatchJobs = useMemo(() => {
    if (jobs.length === 0) return [];
    const sorted = jobs
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const ref = sorted[0];
    if (!ref) return [];
    const windowMs = 1000 * 60 * 10;
    const refTime = new Date(ref.createdAt).getTime();
    const sig = [
      ref.keywords || "",
      ref.fromDate || "",
      ref.toDate || "",
      String(ref.minViewCount ?? ""),
      String(ref.minCommentCount ?? ""),
    ].join("|");
    return sorted.filter((j) => {
      const t = new Date(j.createdAt).getTime();
      if (Math.abs(t - refTime) > windowMs) return false;
      const s = [
        j.keywords || "",
        j.fromDate || "",
        j.toDate || "",
        String(j.minViewCount ?? ""),
        String(j.minCommentCount ?? ""),
      ].join("|");
      return s === sig;
    });
  }, [jobs]);

  const batchKeywords = useMemo(() => {
    const first = latestBatchJobs[0];
    return first ? parseJsonList(first.keywords).map((k) => String(k || "").trim()).filter(Boolean) : [];
  }, [latestBatchJobs]);

  const batchCafes = useMemo(() => {
    return latestBatchJobs
      .map((job) => {
        const ids = parseJsonList(job.cafeIds);
        const names = parseJsonList(job.cafeNames);
        const cafeId = ids[0] || "";
        const cafeName = names[0] || cafeId;
        const p = progressByJobId[job.id] || null;
        const st = resolveDisplayStatus(job.status, p);
        const collected = typeof p?.collected === "number" ? p.collected : (job.resultCount ?? 0);
        return { jobId: job.id, cafeId, cafeName, status: st, collected };
      })
      .filter((c) => c.cafeId);
  }, [latestBatchJobs, progressByJobId]);

  const lookupCell = useCallback(
    (jobId: string, cafeId: string, keyword: string) => {
      const p = progressByJobId[jobId] || null;
      const matrix = p?.keywordMatrix;
      if (!matrix) return null;
      return matrix[makePairKey(cafeId, keyword)] || null;
    },
    [progressByJobId]
  );

  const toggleCafe = (cafeId: string) => {
    setSelectedCafeIds((prev) =>
      prev.includes(cafeId) ? prev.filter((id) => id !== cafeId) : [...prev, cafeId]
    );
  };

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
      if (!res.ok || !data?.success) {
        alert(data?.error || "세션 저장 실패");
        return;
      }
      setStorageStateText("");
      setIsSessionOpen(false);
      setStoredSessionPanelOpen(false);
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
    if (!res.ok || !data?.success) {
      alert(data?.error || "세션 삭제 실패");
      return;
    }
    setIsSessionOpen(true);
    setStoredSessionPanelOpen(true);
    await fetchSession();
    alert("세션 삭제 완료");
  };

  const cancelJob = async (jobId: string) => {
    try {
      setCancellingJobId(jobId);
      const res = await fetch(`/api/scrape-jobs/${jobId}/cancel`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        alert(data?.error || "중단 요청 실패");
        return;
      }
      await fetchJobs();
      await fetchProgress(jobId);
    } finally {
      setCancellingJobId(null);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  const handleCreateJobs = async () => {
    if (keywords.length === 0) {
      alert("키워드를 1개 이상 입력하세요.");
      return;
    }
    const selected = cafes.filter((c) => selectedCafeIds.includes(c.cafeId));
    if (selected.length === 0) {
      alert("스크랩할 카페를 1개 이상 선택하세요.");
      return;
    }

    const { fromDate, toDate } = computeDateRange(datePreset);
    const payloadBase = {
      keywords: keywordToQueryString(keywords),
      fromDate,
      toDate,
      minViewCount: minViewCount.trim() === "" ? null : Number(minViewCount),
      minCommentCount: minCommentCount.trim() === "" ? null : Number(minCommentCount),
      // Simplified mode: do not auto-pick thresholds.
      useAutoFilter: false,
    } as const;

    const raw = maxPostsTotal.trim();
    const total = raw === "" ? null : Number(raw);

    const normalizeTotal = (value: number, cafeCount: number) => {
      const v = Math.floor(Number(value || 0));
      const safe = Number.isFinite(v) ? v : 0;
      return Math.min(300, Math.max(cafeCount, Math.max(1, safe)));
    };

    const distribute = (totalValue: number, cafeCount: number) => {
      const base = Math.floor(totalValue / cafeCount);
      let rem = totalValue - base * cafeCount;
      return Array.from({ length: cafeCount }).map(() => {
        const extra = rem > 0 ? 1 : 0;
        if (rem > 0) rem -= 1;
        return base + extra;
      });
    };

    const perCafeMaxPosts =
      total === null ? Array.from({ length: selected.length }).map(() => null) : distribute(normalizeTotal(total, selected.length), selected.length);

    const postCreate = async (payload: Record<string, unknown>) => {
      const res = await fetch("/api/scrape-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "작업 생성 실패");
      }
      return String(data?.data?.id || "");
    };

    try {
      setCreating(true);
      const created: string[] = [];
      for (let i = 0; i < selected.length; i += 1) {
        const cafe = selected[i];
        const id = await postCreate({
          ...payloadBase,
          maxPosts: perCafeMaxPosts[i],
          selectedCafes: [cafe],
        });
        if (id) created.push(id);
        await new Promise((r) => setTimeout(r, 150));
      }
      await fetchJobs();
      for (const id of created) {
        fetchProgress(id);
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-100 p-4 md:p-8 text-black">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="bg-white border border-slate-200 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-black">카페 아카이빙</h1>
            <p className="text-sm text-slate-700">
              선택한 카페에서 키워드를 검색하고(페이지당 50개, 4페이지), 열람 가능한 글의 본문/댓글 텍스트를 Google Sheets로 보냅니다.
            </p>
            <p className="text-xs text-slate-500 mt-1">
              WEB {shortSha(versionInfo?.sha)} · WORKER {shortSha(workerHeartbeat?.commit)} ·{" "}
              {workerHeartbeat?.at ? `worker ${formatAgo(workerHeartbeat.at)} (${workerHeartbeat.status})` : "worker 신호 없음"}
            </p>
          </div>
          <button onClick={handleLogout} className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg">
            로그아웃
          </button>
        </header>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-black">1) 카페 세션 확인</h2>
            <button
              type="button"
              className="px-2 py-1 text-xs rounded bg-slate-100 text-slate-700"
              onClick={() => {
                const next = !isSessionOpen;
                setIsSessionOpen(next);
                setStoredSessionPanelOpen(next);
              }}
            >
              {isSessionOpen ? "닫기" : "열기"}
            </button>
          </div>

          {sessionLoading ? (
            <p className="text-sm text-slate-600">세션 확인 중...</p>
          ) : session?.hasSession ? (
            <p className="text-sm text-slate-700">세션 사용 가능 ({session.updatedAt ? new Date(session.updatedAt).toLocaleString("ko-KR") : "-"})</p>
          ) : (
            <p className="text-sm text-red-700">세션 없음 (storageState JSON 업로드 필요)</p>
          )}

          {isSessionOpen ? (
            <div className="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-2">
              <p className="text-sm text-slate-700">
                Worker가 네이버에 로그인된 상태로 접속하려면 Playwright storageState(JSON)가 필요합니다. 1회 생성 후 아래에 붙여넣고 저장하세요.
              </p>
              <textarea
                className="w-full h-40 p-2 text-sm border border-slate-200 rounded bg-white text-black"
                placeholder='여기에 storageState JSON 전체를 붙여넣기 (예: {"cookies":[...],"origins":[...]})'
                value={storageStateText}
                onChange={(e) => setStorageStateText(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="px-3 py-2 text-sm bg-slate-900 text-white rounded disabled:opacity-50"
                  onClick={saveSession}
                  disabled={savingSession}
                >
                  세션 저장
                </button>
                <button
                  type="button"
                  className="px-3 py-2 text-sm bg-white border border-slate-200 text-slate-800 rounded"
                  onClick={deleteSession}
                >
                  세션 삭제
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <h2 className="text-lg font-semibold text-black">2) 카페 선택</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={fetchCafes}
              className="px-3 py-2 text-sm bg-slate-900 text-white rounded disabled:opacity-50"
              disabled={cafesLoading}
            >
              가입 카페 불러오기
            </button>
            <span className="text-sm text-slate-600 self-center">
              선택 {selectedCafeIds.length}개
            </span>
          </div>
          {cafesError ? <p className="text-sm text-red-700">{cafesError}</p> : null}
          {cafes.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {cafes.map((cafe) => (
                <label key={cafe.cafeId} className="flex items-start gap-2 p-2 border border-slate-200 rounded-lg bg-white">
                  <input
                    type="checkbox"
                    checked={selectedCafeIds.includes(cafe.cafeId)}
                    onChange={() => toggleCafe(cafe.cafeId)}
                    className="mt-1"
                  />
                  <div className="min-w-0">
                    <div className="font-semibold text-black truncate" title={cafe.name}>
                      {cafe.name}
                    </div>
                    <div className="text-xs text-slate-700 break-all">{cafe.url}</div>
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-600">카페 목록을 불러오면 여기에 표시됩니다.</p>
          )}
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <h2 className="text-lg font-semibold text-black">3) 실행 조건</h2>

          <div className="space-y-1">
            <label className="text-sm text-slate-700">키워드 목록 (쉼표 구분, 공백 자동 제거)</label>
            <KeywordInput value={keywords} onChange={setKeywords} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-sm text-slate-700">기간</label>
              <select
                className="w-full border border-slate-200 rounded px-2 py-2 text-sm bg-white text-black"
                value={datePreset}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "1m" || v === "3m" || v === "6m" || v === "1y" || v === "2y" || v === "all") {
                    setDatePreset(v);
                  }
                }}
              >
                <option value="1m">최근 1개월</option>
                <option value="3m">최근 3개월</option>
                <option value="6m">최근 6개월</option>
                <option value="1y">최근 1년</option>
                <option value="2y">최근 2년</option>
                <option value="all">전체</option>
              </select>
              <div className="text-xs text-slate-600">
                {(() => {
                  const r = computeDateRange(datePreset);
                  if (!r.fromDate || !r.toDate) return "기간 제한 없음";
                  return `${r.fromDate} ~ ${r.toDate}`;
                })()}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm text-slate-700">최소 조회수</label>
              <input
                className="w-full border border-slate-200 rounded px-2 py-2 text-sm bg-white text-black"
                value={minViewCount}
                onChange={(e) => setMinViewCount(e.target.value)}
                placeholder="예: 100"
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm text-slate-700">최소 댓글수</label>
              <input
                className="w-full border border-slate-200 rounded px-2 py-2 text-sm bg-white text-black"
                value={minCommentCount}
                onChange={(e) => setMinCommentCount(e.target.value)}
                placeholder="예: 5"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-sm text-slate-700">최대 수집 글 수 (전체 합산, 비워두면 기본값)</label>
            <input
              className="w-full border border-slate-200 rounded px-2 py-2 text-sm bg-white text-black"
              value={maxPostsTotal}
              onChange={(e) => setMaxPostsTotal(e.target.value)}
              placeholder="예: 300 (빈칸 가능)"
            />
            <div className="text-xs text-slate-600">권장: 60 (절대 상한: 300). 카페/키워드가 많으면 낮게 잡는 게 안정적입니다.</div>
          </div>

          <button
            type="button"
            className="px-4 py-2 text-sm bg-emerald-700 text-white rounded disabled:opacity-50"
            onClick={handleCreateJobs}
            disabled={creating}
          >
            작업 등록 (카페별로 분할)
          </button>
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
          <h2 className="text-lg font-semibold text-black">실행/진행 상황</h2>
          {jobsLoading ? <p className="text-sm text-slate-600">작업 불러오는 중...</p> : null}

          {latestBatchJobs.length > 0 ? (
            <div className="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-black">카페 x 키워드 진행표</p>
                  <p className="text-xs text-slate-600">
                    각 셀은 해당 카페에서 해당 키워드를 검색한 결과입니다. (페이지당 50개, 최대 4페이지)
                  </p>
                </div>
                <div className="text-xs text-slate-600">
                  업데이트:{" "}
                  {(() => {
                    const times = latestBatchJobs
                      .map((j) => progressByJobId[j.id]?.updatedAt)
                      .filter(Boolean)
                      .map((t) => new Date(String(t)).getTime())
                      .filter((t) => Number.isFinite(t));
                    if (times.length === 0) return "-";
                    return formatAgo(new Date(Math.max(...times)).toISOString());
                  })()}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs bg-white border border-slate-200 rounded-md">
                  <thead>
                    <tr className="text-left border-b border-slate-200">
                      <th className="px-2 py-2">키워드 / 카페</th>
                      {batchCafes.map((c) => (
                        <th key={c.cafeId} className="px-2 py-2 whitespace-nowrap" title={c.cafeName}>
                          {shortenCafeName(c.cafeName)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {batchKeywords.map((kw) => (
                      <tr key={kw} className="border-b border-slate-100">
                        <td className="px-2 py-2 font-semibold">{kw}</td>
                        {batchCafes.map((c) => {
                          const cell = lookupCell(c.jobId, c.cafeId, kw);
                          const p = progressByJobId[c.jobId] || null;
                          const isCurrent = p?.cafeId === c.cafeId && p?.keyword === kw && resolveDisplayStatus("RUNNING", p) === "RUNNING";
                          const status = cellStatusLabel(cell, c.status, isCurrent);
                          return (
                            <td
                              key={`${c.cafeId}-${kw}`}
                              className={`px-2 py-2 align-top ${isCurrent ? "bg-blue-50" : ""}`}
                              title={[cellMetaLine(cell), cellPagesLine(cell)].filter(Boolean).join(" / ")}
                            >
                              <div className="space-y-0.5">
                                <div>{status}</div>
                                <div className="text-[11px] text-slate-600">{cellMetaLine(cell)}</div>
                                {cell ? (
                                  <div className="text-[11px] text-slate-400">{cellPagesLine(cell)}</div>
                                ) : null}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                {batchCafes.map((c) => {
                  const p = progressByJobId[c.jobId] || null;
                  const msg = p?.message ? String(p.message) : "-";
                  const when = p?.updatedAt ? formatAgo(p.updatedAt) : "-";
                  return (
                    <div key={c.jobId} className="text-xs border border-slate-200 rounded-md p-2 bg-white">
                      <div className="font-semibold text-slate-800 truncate" title={c.cafeName}>
                        {shortenCafeName(c.cafeName)}
                      </div>
                      <div className="text-slate-600">상태: {c.status} / 수집: {c.collected}</div>
                      <div className="text-slate-600 truncate" title={msg}>메시지: {msg}</div>
                      <div className="text-slate-500">업데이트: {when}</div>
                      {(c.status === "RUNNING" || c.status === "QUEUED") ? (
                        <button
                          type="button"
                          className="mt-2 px-2 py-1 text-xs bg-red-600 text-white rounded disabled:opacity-50"
                          onClick={() => cancelJob(c.jobId)}
                          disabled={cancellingJobId === c.jobId}
                        >
                          {c.status === "QUEUED" ? "대기 취소" : "중단"}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-600">최근 작업이 없습니다.</p>
          )}
        </section>
      </div>
    </main>
  );
}
