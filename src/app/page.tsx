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
  maxPosts: number;
  resultCount: number;
  sheetSynced: number;
  errorMessage: string | null;
  createdAt: string;
};

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

  const [cafes, setCafes] = useState<JoinedCafe[]>([]);
  const [cafesLoading, setCafesLoading] = useState(false);
  const [cafesError, setCafesError] = useState<string | null>(null);
  const [selectedCafeIds, setSelectedCafeIds] = useState<string[]>([]);

  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);

  const [keywords, setKeywords] = useState("");
  const [includeKeywordsText, setIncludeKeywordsText] = useState("");
  const [excludeKeywordsText, setExcludeKeywordsText] = useState("");
  const [datePreset, setDatePreset] = useState<"1m" | "3m" | "6m" | "1y" | "2y" | "all">("3m");
  const [minViewCount, setMinViewCount] = useState("");
  const [minCommentCount, setMinCommentCount] = useState("");
  const [useAutoFilter, setUseAutoFilter] = useState(true);
  const [maxPosts, setMaxPosts] = useState(80);
  const [creating, setCreating] = useState(false);
  const [startingJobId, setStartingJobId] = useState<string | null>(null);

  const keywordCount = useMemo(() => {
    const list = keywords
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return list.length;
  }, [keywords]);

  const recommendedMaxPosts = useMemo(() => {
    // Practical default: keep jobs reasonably small to avoid timeouts / rate-limit.
    // Users can raise it, but we show a safe recommendation.
    if (selectedCafeIds.length === 0) return 80;
    if (keywordCount >= 200) return 30;
    if (keywordCount >= 80) return 50;
    if (keywordCount >= 30) return 60;
    return 80;
  }, [keywordCount, selectedCafeIds.length]);

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
      if (data.success) setSession(data.data);
    } finally {
      setSessionLoading(false);
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

  useEffect(() => {
    fetchSession();
    fetchJobs();
  }, [fetchSession, fetchJobs]);

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
    if (!keywords.trim()) {
      alert("키워드를 입력하세요. 예: 공구,미개봉,할인");
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
          includeKeywords: includeKeywordsText.split(",").map((v) => v.trim()).filter(Boolean),
          excludeKeywords: excludeKeywordsText.split(",").map((v) => v.trim()).filter(Boolean),
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

        <section className="bg-white border border-slate-200 rounded-2xl p-5">
          <h2 className="text-lg font-semibold text-black">1) 카페 세션 확인</h2>
          <p className="text-sm text-black mt-1">
            {sessionLoading
              ? "세션 확인 중..."
              : session?.hasSession
                ? `세션 사용 가능 (${session.lastChecked ? new Date(session.lastChecked).toLocaleString("ko-KR") : "시간 정보 없음"})`
                : "세션 없음 (아래에 storageState JSON 업로드 필요)"}
          </p>
          <div className="mt-4 space-y-2">
            <p className="text-xs text-black">
              Worker가 네이버에 로그인된 상태로 접속하려면 Playwright storageState(JSON)가 필요합니다.
              1회 생성 후 아래에 붙여넣고 저장하세요.
            </p>
            <textarea
              value={storageStateText}
              onChange={(e) => setStorageStateText(e.target.value)}
              placeholder='여기에 storageState JSON 전체를 붙여넣기 (예: {"cookies":[...],"origins":[...]})'
              className="w-full h-40 p-3 border border-slate-200 rounded-lg text-xs font-mono"
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
                className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg min-h-[88px]"
                placeholder="공구,미개봉,한정판"
              />
              <div className="mt-1 text-xs text-slate-600">키워드 개수: {keywordCount}개</div>
            </div>

            <div>
              <label className="text-sm text-slate-700">포함 단어</label>
              <input value={includeKeywordsText} onChange={(e) => setIncludeKeywordsText(e.target.value)} className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg" placeholder="정품,직거래" />
            </div>

            <div>
              <label className="text-sm text-slate-700">제외 단어</label>
              <input value={excludeKeywordsText} onChange={(e) => setExcludeKeywordsText(e.target.value)} className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg" placeholder="판매완료,홍보" />
            </div>

            <div>
              <label className="text-sm text-slate-700">최소 조회수</label>
              <input type="number" min={0} value={minViewCount} onChange={(e) => setMinViewCount(e.target.value)} className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg" />
            </div>

            <div>
              <label className="text-sm text-slate-700">최소 댓글수</label>
              <input type="number" min={0} value={minCommentCount} onChange={(e) => setMinCommentCount(e.target.value)} className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg" />
            </div>

            <div>
              <label className="text-sm text-slate-700">기간</label>
              <select
                value={datePreset}
                onChange={(e) => setDatePreset(e.target.value as any)}
                className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg bg-white"
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
              <input type="number" min={1} max={300} value={maxPosts} onChange={(e) => setMaxPosts(Number(e.target.value) || 80)} className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-lg" />
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

                    return (
                      <tr key={job.id} className="border-b border-slate-100">
                        <td className="py-2">{new Date(job.createdAt).toLocaleString("ko-KR")}</td>
                        <td className="py-2 max-w-[180px] truncate" title={keywordText}>{keywordText}</td>
                        <td className="py-2 max-w-[180px] truncate" title={cafeText}>{cafeText}</td>
                        <td className="py-2">{filterText}</td>
                        <td className="py-2">DB {job.resultCount} / Sheet {job.sheetSynced}</td>
                        <td className="py-2">{job.status}</td>
                        <td className="py-2">
                          {job.status !== "RUNNING" && (
                            <button
                              onClick={() => startJob(job.id)}
                              disabled={startingJobId === job.id}
                              className="px-2 py-1 text-xs bg-slate-800 text-white rounded"
                            >
                              {startingJobId === job.id ? "시작 중" : "재실행"}
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
