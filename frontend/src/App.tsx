import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  bytes,
  statusLabels,
  type Bookmark,
  type Category,
  type Course,
  type DocumentRecord,
  type ExamState,
  type Group,
  type Hit,
  type Job,
  type Preferences,
  type ReadingPosition,
  type SearchContext,
  type Stats,
} from "./types";
import { Setup, CourseModal, ImportModal, type Settings } from "./Setup";
import { Reader } from "./Reader";
import { Highlight } from "./Highlight";
import { Icon } from "./icons";
import { useSearch } from "./useSearch";
import { useWorkspace } from "./useWorkspace";
import {
  BookmarkEditor,
  Dialog,
  ExamPanel,
  JobsPanel,
  PreferencesPanel,
  SavedPanel,
  shortcutValue,
} from "./Panels";

const categories: Category[] = ["Lecture", "Tutorial", "Summary", "Other"];
const categoryNames = {
  Lecture: "Lecture 讲义",
  Tutorial: "Tutorial 习题",
  Summary: "Summary 总结",
  Other: "其他资料",
};
const modeNames = { all: "全部词", any: "任一词", phrase: "完整短语" };
type Panel =
  | "history"
  | "bookmarks"
  | "preferences"
  | "exam"
  | "jobs"
  | "info"
  | null;

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null),
    [startupError, setStartupError] = useState("");
  const [courses, setCourses] = useState<Course[]>([]),
    [documents, setDocuments] = useState<DocumentRecord[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [stats, setStats] = useState<Stats | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null),
    [exam, setExam] = useState<ExamState>({ active: false });
  const [documentsLoaded, setDocumentsLoaded] = useState(false),
    [documentsError, setDocumentsError] = useState("");
  const [panel, setPanel] = useState<Panel>(null),
    [courseModal, setCourseModal] = useState(false),
    [importModal, setImportModal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState(""),
    [tab, setTab] = useState<"search" | "library">("search"),
    [selectedHit, setSelectedHit] = useState("");
  const [bookmarkPosition, setBookmarkPosition] =
    useState<ReadingPosition | null>(null);
  const [expansionPreview, setExpansionPreview] = useState<
    { term: string; source: string }[] | null
  >(null);
  const searchInput = useRef<HTMLInputElement>(null),
    resultList = useRef<HTMLDivElement>(null);
  const notify = useCallback((message: string) => setToast(message), []);
  const search = useSearch(notify);
  const restoreSearch = (context: SearchContext) => {
    search.setDraft(context);
    if (context.query) {
      setTab("search");
      void search.execute(context, false, false);
    }
  };
  const workspace = useWorkspace(
    !!settings?.configured,
    documents,
    notify,
    restoreSearch,
  );
  const { draft, context, response, loading } = search;
  const selection = workspace.selections[workspace.state.active];
  const currentCourse = courses.find((course) => course.id === draft.course);
  const courseDocuments = documents.filter(
    (doc) => !draft.course || doc.course_id === draft.course,
  );
  const filteredDocuments = courseDocuments.filter(
    (doc) => !draft.category || doc.category === draft.category,
  );
  const categoryLabel =
    categoryNames[draft.category as Category] || draft.category;
  const importing = jobs.some(
    (job) => !job.done && (!draft.course || job.course_id === draft.course),
  );
  const flatHits =
    response?.groups.flatMap((group) =>
      group.hits.map((hit) => ({ group, hit })),
    ) ?? [];
  const otherPane = (): 0 | 1 => (workspace.state.active === 0 ? 1 : 0);
  const loadSettings = useCallback(() => {
    void api<Settings>("/settings")
      .then(setSettings)
      .catch((reason) => setStartupError(reason.message));
  }, []);
  useEffect(loadSettings, [loadSettings]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 7000);
    return () => clearTimeout(timer);
  }, [toast]);

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      api<Course[]>("/courses").then(setCourses),
      api<DocumentRecord[]>("/documents")
        .then((next) => {
          setDocuments(next);
          setDocumentsLoaded(true);
          setDocumentsError("");
        })
        .catch((reason) => {
          setDocumentsError(reason.message);
          throw reason;
        }),
      api<Job[]>("/import-jobs").then(setJobs),
      api<ExamState>("/exam").then(setExam),
      // Storage statistics are optional and must never block library updates.
      api<Stats>("/stats")
        .then(setStats)
        .catch(() => setStats(null)),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }, []);
  useEffect(() => {
    if (!settings?.configured) return;
    let busy = false;
    let lastError = "";
    const update = async () => {
      if (busy) return;
      busy = true;
      try {
        await refresh();
        lastError = "";
      } catch (reason) {
        const message = (reason as Error).message;
        if (message !== lastError) notify(message);
        lastError = message;
      } finally {
        busy = false;
      }
    };
    void update();
    void api<Preferences>("/preferences")
      .then(setPreferences)
      .catch((reason) => notify(reason.message));
    const timer = setInterval(() => void update(), 2500);
    return () => clearInterval(timer);
  }, [settings?.configured, refresh, notify]);
  useEffect(() => {
    if (workspace.ready) workspace.setSearch(draft);
  }, [draft, workspace.ready, workspace.setSearch]);
  useEffect(() => {
    if (
      draft.document &&
      selection?.document &&
      draft.document !== selection.document.id
    )
      search.setDraft((previous) => ({
        ...previous,
        document: selection.document.id,
        course: selection.document.course_id,
      }));
  }, [selection?.document.id, draft.document]);
  useEffect(() => {
    setExpansionPreview(null);
  }, [draft.query, draft.mode, draft.course]);

  const patchDraft = (patch: Partial<SearchContext>, reset = false) => {
    search.setDraft((previous) => ({ ...previous, ...patch }));
    if (reset) {
      search.clear();
      setSelectedHit("");
    }
  };
  const submitSearch = () => {
    if (!draft.query.trim()) {
      searchInput.current?.focus();
      return;
    }
    setTab("search");
    setSelectedHit("");
    void search.execute(draft);
  };
  const openHit = async (group: Group, hit: Hit, other = false) => {
    const target = other ? otherPane() : workspace.state.active;
    try {
      let doc = documents.find((item) => item.id === group.document_id);
      if (!doc || doc.version !== group.version) {
        const latest = await api<DocumentRecord[]>("/documents");
        setDocuments(latest);
        doc = latest.find((item) => item.id === group.document_id);
      }
      if (!doc || doc.version !== group.version) {
        notify("资料已更新，请重新搜索。");
        return;
      }
      setSelectedHit(hit.unit_id);
      workspace.open(doc, context, hit, target);
    } catch (reason) {
      notify((reason as Error).message);
    }
  };
  const rebuild = (id: string) => {
    void api(`/documents/${id}/rebuild`, { method: "POST" })
      .then(async () => {
        await refresh();
        setPanel("jobs");
      })
      .catch((reason) => notify(reason.message));
  };
  const beginImport = () => {
    if (!courses.length) setCourseModal(true);
    else setImportModal(true);
  };
  const saveBookmark = () => {
    const position = workspace.current()?.position;
    if (!position) {
      notify("请先打开并阅读一页或一个段落。");
      return;
    }
    void api<ReadingPosition>("/positions/capture", {
      method: "POST",
      body: JSON.stringify(position),
    })
      .then(setBookmarkPosition)
      .catch((reason) => notify(reason.message));
  };
  const openSaved = async (
    next: SearchContext | null,
    bookmark?: Bookmark,
    other?: boolean,
  ) => {
    if (next) {
      setPanel(null);
      setTab("search");
      await search.execute(next);
      return;
    }
    if (!bookmark) return;
    try {
      const resolved = await api<{ status: string; position: ReadingPosition }>(
        "/positions/resolve",
        { method: "POST", body: JSON.stringify(bookmark.position) },
      );
      if (resolved.status !== "resolved")
        throw new Error("资料已变化，请先确认并重新绑定收藏位置。");
      const doc = documents.find((item) => item.id === bookmark.document_id);
      if (!doc) throw new Error("资料不存在。");
      workspace.open(
        doc,
        null,
        undefined,
        other ? otherPane() : undefined,
        resolved.position,
      );
      setPanel(null);
    } catch (reason) {
      notify((reason as Error).message);
    }
  };
  const keyboard = useRef<(event: KeyboardEvent) => void>(() => {});
  keyboard.current = (event) => {
    if (event.key === "Escape") {
      setPanel(null);
      setCourseModal(false);
      setImportModal(false);
      setBookmarkPosition(null);
      return;
    }
    if (panel || courseModal || importModal || bookmarkPosition) return;
    const combo = shortcutValue(event),
      shortcuts = preferences?.shortcuts;
    if (
      combo === (shortcuts?.search ?? "Meta+k") ||
      (!event.metaKey && event.ctrlKey && event.key.toLowerCase() === "k")
    ) {
      event.preventDefault();
      searchInput.current?.focus();
      searchInput.current?.select();
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]"))
      return;
    if (combo === (shortcuts?.back ?? "Alt+ArrowLeft")) {
      event.preventDefault();
      void workspace.travel("back");
    }
    if (combo === (shortcuts?.forward ?? "Alt+ArrowRight")) {
      event.preventDefault();
      void workspace.travel("forward");
    }
    if (
      combo === (shortcuts?.bookmark ?? "Meta+d") &&
      target.closest("[data-reader-pane]")
    ) {
      event.preventDefault();
      saveBookmark();
    }
    if (combo === (shortcuts?.pane1 ?? "Alt+Digit1")) {
      event.preventDefault();
      workspace.activate(0);
      document.querySelector<HTMLElement>('[data-reader-pane="0"]')?.focus();
    }
    if (combo === (shortcuts?.pane2 ?? "Alt+Digit2") && workspace.state.dual) {
      event.preventDefault();
      workspace.activate(1);
      document.querySelector<HTMLElement>('[data-reader-pane="1"]')?.focus();
    }
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => keyboard.current(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const resultKeys = (event: React.KeyboardEvent) => {
    if (
      !["ArrowDown", "ArrowUp", "Enter"].includes(event.key) ||
      !flatHits.length
    )
      return;
    const target = event.target as HTMLElement;
    const focusedHit = target.closest<HTMLElement>(".hit-card")?.dataset.hit;
    if (event.key === "Enter" && target.closest("button") && !focusedHit)
      return;
    event.preventDefault();
    const index = flatHits.findIndex(
      (item) => item.hit.unit_id === (focusedHit ?? selectedHit),
    );
    if (event.key === "Enter") {
      const item = flatHits[Math.max(0, index)];
      openHit(item.group, item.hit, event.shiftKey);
      return;
    }
    const next =
      index < 0
        ? 0
        : Math.max(
            0,
            Math.min(
              flatHits.length - 1,
              index + (event.key === "ArrowDown" ? 1 : -1),
            ),
          );
    setSelectedHit(flatHits[next].hit.unit_id);
    resultList.current
      ?.querySelector(`[data-hit="${flatHits[next].hit.unit_id}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  if (startupError)
    return (
      <div className="startup-message">
        <Icon name="info" size={28} />
        <h1>暂时无法连接本地服务</h1>
        <p>{startupError}</p>
        <button
          className="primary"
          onClick={() => {
            setStartupError("");
            loadSettings();
          }}
        >
          重试连接
        </button>
      </div>
    );
  if (!settings)
    return (
      <div className="startup-message">
        <span className="spinner" />
        <p>正在打开你的资料库…</p>
      </div>
    );
  return (
    <>
      {!settings.configured ? (
        <Setup settings={settings} onDone={loadSettings} onError={notify} />
      ) : (
        <div
          className={`app-shell ${workspace.state.dual ? "comparison" : ""} ${sidebarOpen ? "sidebar-open" : ""}`}
        >
          <aside className="sidebar">
            <a className="brand" href="/" aria-label="书间首页">
              <span className="brand-icon">
                <Icon name="book" size={21} />
              </span>
              <span>
                书间<small>COURSE SEARCH · V2</small>
              </span>
            </a>
            <div className="sidebar-section-heading">
              <span>我的课程</span>
              <button
                className="icon-button"
                title="新建课程"
                disabled={exam.active}
                onClick={() => setCourseModal(true)}
              >
                <Icon name="plus" size={16} />
              </button>
            </div>
            <nav className="course-nav">
              <button
                className={!draft.course ? "nav-item active" : "nav-item"}
                onClick={() => patchDraft({ course: "", document: "" }, true)}
              >
                <Icon name="grid" size={17} />
                <span>全部课程</span>
                <small>{documents.length}</small>
              </button>
              {courses.map((course, index) => (
                <button
                  className={
                    draft.course === course.id ? "nav-item active" : "nav-item"
                  }
                  key={course.id}
                  onClick={() =>
                    patchDraft({ course: course.id, document: "" }, true)
                  }
                >
                  <span className={`course-symbol symbol-${index % 4}`}>
                    {course.name
                      .replace(/[^a-zA-Z\d\u4e00-\u9fa5]/g, "")
                      .slice(0, 2)
                      .toUpperCase()}
                  </span>
                  <span title={course.name}>{course.name}</span>
                  <small>{course.document_count}</small>
                </button>
              ))}
            </nav>
            {!courses.length && (
              <button
                className="first-course"
                disabled={exam.active}
                onClick={() => setCourseModal(true)}
              >
                <Icon name="plus" size={14} />
                添加第一门课程
              </button>
            )}
            <div className="sidebar-line" />
            <div className="sidebar-section-heading">
              <span>资料分类</span>
            </div>
            <nav className="category-nav">
              <button
                className={
                  !draft.category ? "category-item active" : "category-item"
                }
                onClick={() => patchDraft({ category: "" }, true)}
              >
                <Icon name="folder" size={16} />
                <span>所有资料</span>
                <small>{courseDocuments.length}</small>
              </button>
              {categories.map((item) => (
                <button
                  className={
                    draft.category === item
                      ? "category-item active"
                      : "category-item"
                  }
                  key={item}
                  onClick={() => patchDraft({ category: item }, true)}
                >
                  <span className={`category-dot ${item.toLowerCase()}`} />
                  <span>{categoryNames[item]}</span>
                  <small>
                    {
                      courseDocuments.filter((doc) => doc.category === item)
                        .length
                    }
                  </small>
                </button>
              ))}
            </nav>
            <div className="sidebar-line" />
            <nav className="category-nav personal-nav">
              <button
                className="category-item"
                onClick={() => setPanel("history")}
              >
                <Icon name="history" size={16} />
                搜索历史
              </button>
              <button
                className="category-item"
                onClick={() => setPanel("bookmarks")}
              >
                <Icon name="bookmark" size={16} />
                收藏与标签
              </button>
              <button
                className="category-item"
                onClick={() => setPanel("preferences")}
              >
                <Icon name="settings" size={16} />
                快捷键与搜索设置
              </button>
              <button
                className="category-item"
                onClick={() => setPanel("exam")}
              >
                <Icon name="check" size={16} />
                考试自检
              </button>
            </nav>
            <div className="sidebar-bottom">
              <button className="index-status" onClick={() => setPanel("jobs")}>
                <span
                  className={stats?.pending ? "spinner small" : "status-dot"}
                />
                <span>
                  {stats?.pending
                    ? `${stats.pending} 份资料正在处理`
                    : "查看索引与导入状态"}
                </span>
                <Icon name="arrow" size={13} />
              </button>
              <button className="storage" onClick={() => setPanel("info")}>
                <Icon name="lock" size={14} />
                <span>
                  仅存储于本机
                  <small>
                    {stats ? bytes(stats.storage_bytes) : "…"} · 查看资料库
                  </small>
                </span>
              </button>
            </div>
          </aside>
          <div className="workspace">
            <header className="workspace-header">
              <div className="workspace-breadcrumb">
                <span className="breadcrumb">资料工作台</span>
                <Icon name="arrow" size={13} />
                <strong>{currentCourse?.name || "全部课程"}</strong>
              </div>
              <nav className="workspace-header-actions" aria-label="查阅工具">
                <button
                  className="icon-button"
                  aria-label="返回阅读位置"
                  title="返回阅读位置"
                  disabled={
                    !workspace.state.panes[workspace.state.active].back.length
                  }
                  onClick={() => {
                    void workspace.travel("back");
                  }}
                >
                  <Icon name="left" size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="前进阅读位置"
                  title="前进阅读位置"
                  disabled={
                    !workspace.state.panes[workspace.state.active].forward
                      .length
                  }
                  onClick={() => {
                    void workspace.travel("forward");
                  }}
                >
                  <Icon name="arrow" size={16} />
                </button>
                <span className="header-tool-divider" />
                <button
                  className="icon-button"
                  aria-label="历史"
                  title="搜索历史"
                  onClick={() => setPanel("history")}
                >
                  <Icon name="history" size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="收藏"
                  title="收藏与标签"
                  onClick={() => setPanel("bookmarks")}
                >
                  <Icon name="bookmark" size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="快捷键"
                  title="快捷键与搜索设置"
                  onClick={() => setPanel("preferences")}
                >
                  <Icon name="settings" size={16} />
                </button>
                <button
                  className="compact-action"
                  aria-pressed={workspace.state.dual}
                  onClick={workspace.toggleDual}
                >
                  <Icon name="split" size={15} />
                  {workspace.state.dual ? "关闭双栏" : "双文档对照"}
                </button>
                {workspace.state.dual && (
                  <button
                    className="icon-button"
                    aria-label={sidebarOpen ? "收起课程侧栏" : "展开课程侧栏"}
                    title={sidebarOpen ? "收起课程侧栏" : "展开课程侧栏"}
                    onClick={() => setSidebarOpen((value) => !value)}
                  >
                    <Icon name="folder" size={16} />
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label={
                    workspace.state.collapsed ? "显示结果" : "收起结果"
                  }
                  title={workspace.state.collapsed ? "显示结果" : "收起结果"}
                  onClick={workspace.toggleResults}
                >
                  <Icon name="search" size={16} />
                </button>
              </nav>
              <button
                className={`offline-badge ${exam.active ? "exam-active" : ""}`}
                aria-label="自检"
                onClick={() => setPanel("exam")}
              >
                <span className="status-dot" />
                {exam.active ? "考试模式 · 资料已冻结" : "离线可用 · 考前自检"}
              </button>
              <button
                className="primary import-button"
                disabled={exam.active}
                onClick={beginImport}
              >
                <Icon name="plus" size={16} />
                导入资料
              </button>
            </header>
            <section className="search-area">
              <form
                className="search-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitSearch();
                }}
              >
                <Icon name="search" size={21} />
                <input
                  ref={searchInput}
                  aria-label="搜索课程资料"
                  placeholder="输入术语或短语，例如 deadlock"
                  value={draft.query}
                  maxLength={500}
                  onChange={(event) =>
                    patchDraft({ query: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && flatHits.length) {
                      event.preventDefault();
                      resultList.current?.focus();
                      setSelectedHit(flatHits[0].hit.unit_id);
                    }
                  }}
                />
                <kbd>⌘ K</kbd>
                <button
                  className="primary search-button"
                  disabled={loading || !workspace.ready || !draft.query.trim()}
                >
                  {loading ? <span className="spinner small light" /> : "搜索"}
                  <Icon name="arrow" size={16} />
                </button>
              </form>
              <div className="search-options">
                <div className="search-primary-options">
                  <div
                    className="mode-switch"
                    aria-label="搜索模式"
                    title={
                      draft.mode === "phrase"
                        ? "完整短语不跨页或段落"
                        : draft.mode === "all"
                          ? "同一页或段落包含全部词组"
                          : "包含任一词组"
                    }
                  >
                    {(Object.keys(modeNames) as (keyof typeof modeNames)[]).map(
                      (item) => (
                        <button
                          key={item}
                          className={draft.mode === item ? "active" : ""}
                          onClick={() => patchDraft({ mode: item })}
                        >
                          {modeNames[item]}
                        </button>
                      ),
                    )}
                  </div>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={draft.expand}
                      onChange={(e) => patchDraft({ expand: e.target.checked })}
                    />
                    本地词形与同义词
                  </label>
                  <button
                    className="text-button"
                    disabled={!draft.query.trim()}
                    onClick={() => {
                      const params = new URLSearchParams({
                        q: draft.query,
                        mode: draft.mode,
                      });
                      if (draft.course) params.set("course_id", draft.course);
                      void api<{
                        expansions: { term: string; source: string }[];
                      }>(`/search/expansions?${params}`)
                        .then((result) =>
                          setExpansionPreview(result.expansions),
                        )
                        .catch((reason) => notify(reason.message));
                    }}
                  >
                    查看扩展词
                  </button>
                </div>
                <div className="search-refinements">
                  <label>
                    范围{" "}
                    <select
                      aria-label="搜索范围"
                      value={draft.document ? "document" : "course"}
                      onChange={(e) => {
                        if (e.target.value === "document" && selection)
                          patchDraft({
                            document: selection.document.id,
                            course: selection.document.course_id,
                          });
                        else patchDraft({ document: "" });
                      }}
                    >
                      <option value="course">
                        {draft.course ? "当前课程" : "全部课程"}
                      </option>
                      <option value="document" disabled={!selection}>
                        当前文件
                      </option>
                    </select>
                  </label>
                  <label>
                    排序{" "}
                    <select
                      aria-label="搜索排序"
                      value={draft.sort}
                      onChange={(e) =>
                        patchDraft({
                          sort: e.target.value as SearchContext["sort"],
                        })
                      }
                    >
                      <option value="relevance">原词优先 · 相关性</option>
                      <option value="category">原词优先 · 类别顺序</option>
                    </select>
                  </label>
                </div>
              </div>
              {expansionPreview && (
                <p className="expansion-preview">
                  直接扩展：
                  {expansionPreview.length
                    ? expansionPreview
                        .map(
                          (item) =>
                            `${item.term}（${item.source === "form" ? "词形" : "同义词"}）`,
                        )
                        .join("、")
                    : "没有收录的扩展词"}
                </p>
              )}
            </section>
            <main
              className={`content-grid v2-grid ${workspace.state.dual ? "dual-grid" : ""} ${workspace.state.collapsed ? "results-collapsed" : ""}`}
            >
              <section className="results-panel">
                <div className="results-tabs">
                  <button
                    className={tab === "search" ? "active" : ""}
                    onClick={() => setTab("search")}
                  >
                    搜索结果{response && <span>{response.total_hits}</span>}
                  </button>
                  <button
                    className={tab === "library" ? "active" : ""}
                    onClick={() => setTab("library")}
                  >
                    课程资料<span>{filteredDocuments.length}</span>
                  </button>
                  <button
                    className="icon-button jobs-toggle"
                    title="查看导入任务"
                    onClick={() => setPanel("jobs")}
                  >
                    <Icon name="activity" size={16} />
                  </button>
                </div>
                <div
                  className="results-scroll"
                  ref={resultList}
                  tabIndex={0}
                  onKeyDown={resultKeys}
                  aria-label="检索结果列表"
                >
                  {tab === "search" ? (
                    <>
                      {loading && !response ? (
                        <div className="empty-results">
                          <span className="spinner" />
                          <h3>正在检索本地索引</h3>
                        </div>
                      ) : response ? (
                        <>
                          <div className="results-summary">
                            <span>“{context?.query}”</span>
                            <small>
                              {response.total_documents} 个文件 ·{" "}
                              {response.total_hits} 处命中
                            </small>
                          </div>
                          {!response.groups.length && (
                            <div className="empty-results">
                              <Icon name="search" size={28} />
                              <h3>没有找到匹配内容</h3>
                              <p>
                                试试更短的术语、任一词模式或本地扩展。扫描图片文字不参与检索。
                              </p>
                            </div>
                          )}
                          {response.groups.map((group) => (
                            <article
                              className="result-group"
                              key={group.document_id}
                            >
                              <div className="result-file">
                                <span className={`file-label ${group.kind}`}>
                                  {group.kind.toUpperCase()}
                                </span>
                                <div>
                                  <strong title={group.name}>
                                    {group.name}
                                  </strong>
                                  <small>
                                    {group.course_name} · {group.category}
                                  </small>
                                </div>
                                <span className="hit-count">
                                  {group.hit_count}
                                </span>
                              </div>
                              {group.hits.map((hit) => (
                                <div className="hit-row" key={hit.unit_id}>
                                  <button
                                    data-hit={hit.unit_id}
                                    className={
                                      selectedHit === hit.unit_id
                                        ? "hit-card selected"
                                        : "hit-card"
                                    }
                                    onClick={() => openHit(group, hit)}
                                  >
                                    <div>
                                      <span>{hit.label}</span>
                                      <small>
                                        {hit.match_count} 处
                                        <Icon name="arrow" size={12} />
                                      </small>
                                    </div>
                                    <p>
                                      {hit.snippet.prefix && "…"}
                                      <Highlight
                                        text={hit.snippet.text}
                                        ranges={hit.snippet.ranges}
                                      />
                                      {hit.snippet.suffix && "…"}
                                    </p>
                                    {context?.expand && (
                                      <span className="match-sources">
                                        {Array.from(
                                          new Set(
                                            hit.matches?.map(
                                              (match) =>
                                                `${match.source === "original" ? "原词" : match.source === "form" ? "词形" : "同义词"}：${match.term}`,
                                            ),
                                          ),
                                        ).join(" · ")}
                                      </span>
                                    )}
                                  </button>
                                  <button
                                    className="other-open"
                                    aria-label={`在另一栏打开 ${group.name} ${hit.label}`}
                                    onClick={() => openHit(group, hit, true)}
                                  >
                                    <Icon name="split" size={13} />
                                    在另一栏打开
                                  </button>
                                </div>
                              ))}
                              {group.next_unit_offset != null && (
                                <button
                                  className="text-button more-units"
                                  onClick={() => {
                                    void search.loadUnits(group);
                                  }}
                                >
                                  加载本文件更多位置 ({group.hits.length}/
                                  {group.unit_total})
                                  <Icon name="down" size={13} />
                                </button>
                              )}
                            </article>
                          ))}
                          {response.next_offset != null && context && (
                            <button
                              className="secondary more-results"
                              disabled={loading}
                              onClick={() => {
                                void search.execute(context, true, false);
                              }}
                            >
                              {loading ? "加载中…" : "加载更多文件"}
                            </button>
                          )}
                        </>
                      ) : (
                        <div className="empty-results idle">
                          <Icon name="search" size={28} />
                          <span className="eyebrow">SEARCH YOUR KNOWLEDGE</span>
                          <h2>从一个关键词开始</h2>
                          <p>
                            查找定义、例题或关键概念，
                            <br />
                            让每一次搜索都有原文可循。
                          </p>
                          <div className="search-examples">
                            试着搜索{" "}
                            <button
                              onClick={() => {
                                patchDraft({ query: "deadlock" });
                                searchInput.current?.focus();
                              }}
                            >
                              deadlock
                            </button>
                            <button
                              onClick={() => {
                                patchDraft({
                                  query: "mutual exclusion",
                                  mode: "phrase",
                                });
                                searchInput.current?.focus();
                              }}
                            >
                              mutual exclusion
                            </button>
                          </div>
                          {!documents.length && (
                            <button
                              className="text-button"
                              disabled={exam.active}
                              onClick={beginImport}
                            >
                              先导入你的课程资料
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="results-summary">
                        <span>{categoryLabel || "本地资料"}</span>
                        <small>{filteredDocuments.length} 个文件</small>
                      </div>
                      {filteredDocuments.map((doc) => (
                        <article
                          className={`document-card ${selection?.document.id === doc.id ? "selected" : ""}`}
                          key={doc.id}
                        >
                          <button
                            className="document-open"
                            onClick={() => workspace.open(doc, null)}
                          >
                            <span className={`file-label ${doc.kind}`}>
                              {doc.kind.toUpperCase()}
                            </span>
                            <div>
                              <strong title={doc.relative_path}>
                                {doc.name}
                              </strong>
                              <span>
                                {doc.course_name} · {doc.searchable_count}/
                                {doc.unit_count}{" "}
                                {doc.kind === "pdf" ? "页" : "单元"}可搜索
                              </span>
                              <small className={`status-text ${doc.status}`}>
                                <span className="status-dot" />
                                {statusLabels[doc.status]}
                              </small>
                            </div>
                            <Icon name="arrow" size={14} />
                          </button>
                          <div className="document-actions">
                            <select
                              aria-label={`${doc.name}的分类`}
                              disabled={exam.active}
                              value={doc.category}
                              onChange={(event) => {
                                void api(`/documents/${doc.id}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({
                                    category: event.target.value,
                                  }),
                                })
                                  .then(refresh)
                                  .catch((reason) => notify(reason.message));
                              }}
                            >
                              {categories.map((item) => (
                                <option key={item}>{item}</option>
                              ))}
                            </select>
                            <button
                              className="text-button"
                              onClick={() =>
                                workspace.open(
                                  doc,
                                  null,
                                  undefined,
                                  otherPane(),
                                )
                              }
                            >
                              在另一栏打开
                            </button>
                            <span>{bytes(doc.size)}</span>
                            <button
                              className="icon-button"
                              title="重新建立索引"
                              disabled={exam.active}
                              onClick={() => rebuild(doc.id)}
                            >
                              <Icon name="refresh" size={14} />
                            </button>
                          </div>
                        </article>
                      ))}
                      {!filteredDocuments.length && (
                        <div className="empty-results">
                          {documentsError ? (
                            <>
                              <h3>资料列表暂时无法刷新</h3>
                              <p>{documentsError}</p>
                              <button
                                className="secondary"
                                onClick={() =>
                                  void refresh().catch((reason) =>
                                    notify(reason.message),
                                  )
                                }
                              >
                                重试
                              </button>
                            </>
                          ) : !documentsLoaded ? (
                            <h3>正在加载资料…</h3>
                          ) : courseDocuments.length ? (
                            <>
                              <h3>当前分类下没有资料</h3>
                              <p>
                                {currentCourse?.name || "资料库"}已有{" "}
                                {courseDocuments.length} 份资料，当前筛选为
                                {categoryLabel}。
                              </p>
                              <button
                                className="secondary"
                                onClick={() =>
                                  patchDraft({ category: "" }, true)
                                }
                              >
                                显示所有资料
                              </button>
                            </>
                          ) : importing ? (
                            <>
                              <h3>资料正在建立索引</h3>
                              <p>完成后会自动显示在这里。</p>
                              <button
                                className="secondary"
                                onClick={() => setPanel("jobs")}
                              >
                                查看导入进度
                              </button>
                            </>
                          ) : (
                            <>
                              <h3>这里还没有资料</h3>
                              <button
                                className="secondary"
                                disabled={exam.active}
                                onClick={beginImport}
                              >
                                导入资料
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="results-footer">
                  <span>↑ ↓ 选择</span>
                  <span>Enter 打开 · Shift+Enter 另一栏</span>
                </div>
              </section>
              <div className="readers-area">
                <div className="pane-tabs">
                  <button
                    className={workspace.state.active === 0 ? "active" : ""}
                    onClick={() => workspace.activate(0)}
                  >
                    阅读区 1
                  </button>
                  {workspace.state.dual && (
                    <button
                      className={workspace.state.active === 1 ? "active" : ""}
                      onClick={() => workspace.activate(1)}
                    >
                      阅读区 2
                    </button>
                  )}
                </div>
                <div className="reader-panes">
                  {([0, 1] as const)
                    .filter((index) => index === 0 || workspace.state.dual)
                    .map((index) => (
                      <div
                        className={`reader-pane ${workspace.state.active === index ? "active-pane" : ""}`}
                        data-reader-pane={index}
                        aria-label={`阅读区 ${index + 1}`}
                        key={index}
                        tabIndex={0}
                        onFocus={() => workspace.activate(index)}
                        onPointerDown={() => workspace.activate(index)}
                      >
                        <Reader
                          paneId={`pane-${index}`}
                          selection={workspace.selections[index]}
                          frozen={exam.active}
                          onClose={() => workspace.close(index)}
                          onError={notify}
                          onRebuild={rebuild}
                          onPosition={(position) => {
                            const id = workspace.selections[index]?.visitId;
                            if (id)
                              workspace.updatePosition(index, id, position);
                          }}
                          onBookmark={saveBookmark}
                        />
                      </div>
                    ))}
                </div>
              </div>
            </main>
          </div>
        </div>
      )}
      {courseModal && (
        <CourseModal
          onClose={() => setCourseModal(false)}
          onCreate={async (name) => {
            try {
              const created = await api<Course>("/courses", {
                method: "POST",
                body: JSON.stringify({ name }),
              });
              await refresh();
              patchDraft({ course: created.id, document: "" }, true);
              setCourseModal(false);
            } catch (reason) {
              notify((reason as Error).message);
            }
          }}
        />
      )}
      {importModal && (
        <ImportModal
          courses={courses}
          defaultCourse={draft.course}
          onClose={() => setImportModal(false)}
          onError={notify}
          onImported={(courseId) => {
            setImportModal(false);
            patchDraft({ course: courseId, category: "", document: "" }, true);
            setTab("library");
            setPanel("jobs");
            void refresh().catch((reason) => notify(reason.message));
          }}
        />
      )}
      {(panel === "history" || panel === "bookmarks") && (
        <SavedPanel
          kind={panel}
          course={draft.course}
          courses={courses}
          close={() => setPanel(null)}
          error={notify}
          rebindPosition={workspace.current()?.position}
          open={(next, bookmark, other) => {
            void openSaved(next, bookmark, other);
          }}
        />
      )}
      {panel === "preferences" && preferences && (
        <PreferencesPanel
          preferences={preferences}
          courses={courses}
          frozen={exam.active}
          close={() => setPanel(null)}
          saved={setPreferences}
          error={notify}
        />
      )}
      {panel === "exam" && (
        <ExamPanel
          course={draft.course}
          exam={exam}
          changed={setExam}
          close={() => setPanel(null)}
          error={notify}
        />
      )}
      {panel === "jobs" && (
        <JobsPanel
          jobs={jobs}
          frozen={exam.active}
          close={() => setPanel(null)}
          refresh={refresh}
          error={notify}
        />
      )}
      {panel === "info" && (
        <Dialog title="本地资料库" close={() => setPanel(null)}>
          <p>文件副本、索引、收藏和阅读历史保存在以下目录。</p>
          <code className="library-path">
            {stats?.library_path || settings.library_path}
          </code>
          <div className="library-metrics">
            <span>
              <strong>
                {stats?.documents ?? (documentsLoaded ? documents.length : "…")}
              </strong>
              份资料
            </span>
            <span>
              <strong>
                {stats?.searchable_units ??
                  (documentsLoaded
                    ? documents.reduce(
                        (total, doc) => total + doc.searchable_count,
                        0,
                      )
                    : "…")}
              </strong>
              可搜索单元
            </span>
            <span>
              <strong>{stats ? bytes(stats.storage_bytes) : "暂不可用"}</strong>
              本地占用
            </span>
          </div>
          <p className="subtle">
            备份前先关闭服务，再复制整个资料库。V1 升级备份位于资料库 backups
            文件夹；旧版应用不能直接打开已升级数据库。
          </p>
        </Dialog>
      )}
      {bookmarkPosition && (
        <BookmarkEditor
          position={bookmarkPosition}
          close={() => setBookmarkPosition(null)}
          saved={() => {
            setBookmarkPosition(null);
            notify("收藏已保存。");
          }}
          error={notify}
        />
      )}
      {toast && (
        <div className="toast" role="alert">
          <Icon name="info" size={17} />
          <span>{toast}</span>
          <button
            className="icon-button"
            title="关闭提示"
            onClick={() => setToast("")}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      )}
    </>
  );
}
