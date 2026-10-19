import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  bytes,
  statusLabels,
  type Category,
  type Course,
  type DocumentRecord,
  type Group,
  type Job,
  type Mode,
  type SearchResponse,
  type Selection,
  type Stats,
  type Hit,
} from "./types";
import { Highlight } from "./Highlight";
import { Icon } from "./icons";
import { Reader } from "./Reader";

const categories: Category[] = ["Lecture", "Tutorial", "Summary", "Other"];
const categoryNames = {
  Lecture: "Lecture 讲义",
  Tutorial: "Tutorial 习题",
  Summary: "Summary 总结",
  Other: "其他资料",
};
const modeNames = { all: "全部词", any: "任一词", phrase: "完整短语" };
type Settings = {
  configured: boolean;
  library_path: string;
  suggested_path: string;
};

function Setup({
  settings,
  onDone,
  onError,
}: {
  settings: Settings;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [path, setPath] = useState(settings.suggested_path);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const configure = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await api("/settings", {
        method: "POST",
        body: JSON.stringify({ library_path: path }),
      });
      onDone();
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="setup-page">
      <div className="setup-brand">
        <span className="brand-icon">
          <Icon name="book" size={24} />
        </span>
        书间<span>Course Search</span>
      </div>
      <div className="setup-card">
        <span className="eyebrow">YOUR MATERIALS, WITHIN REACH</span>
        <h1>让资料，触手可及。</h1>
        <p>
          把课程讲义与笔记放在一起。输入关键词，
          <br />
          找到内容，直接回到原文。
        </p>
        <div className="setup-features">
          <span>
            <Icon name="folder" />
            PDF / DOCX
          </span>
          <span>
            <Icon name="search" />
            原文定位
          </span>
          <span>
            <Icon name="lock" />
            完全本地
          </span>
        </div>
        <form onSubmit={configure}>
          <label htmlFor="library-path">选择你的资料库目录</label>
          <div className="path-input">
            <input
              id="library-path"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              required
            />
            <button
              type="button"
              disabled={picking}
              onClick={async () => {
                setPicking(true);
                try {
                  const result = await api<{ path: string | null }>(
                    "/settings/pick-directory",
                    { method: "POST" },
                  );
                  if (result.path) setPath(result.path);
                } catch (reason) {
                  onError((reason as Error).message);
                } finally {
                  setPicking(false);
                }
              }}
            >
              {picking ? "选择中…" : "浏览…"}
            </button>
          </div>
          <small>
            导入时会保存文件副本与索引，原始资料保持不变。目录不存在时会自动创建。
          </small>
          <button
            className="primary setup-submit"
            disabled={saving || picking || !path.trim()}
          >
            {saving ? "正在准备…" : "创建资料库，开始使用"}
            <Icon name="arrow" size={16} />
          </button>
        </form>
      </div>
      <div className="setup-footer">
        <Icon name="lock" size={14} /> 无需账号 · 无云端依赖 · 安装后离线使用
      </div>
    </div>
  );
}

function CourseModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal small-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="course-heading"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <h2 id="course-heading">新建课程</h2>
          <button className="icon-button" title="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <p>按课程整理资料，搜索时更容易缩小范围。</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await onCreate(name);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="course-name">课程名称</label>
          <input
            id="course-name"
            autoFocus
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 CS2106 操作系统"
            required
          />
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>
              取消
            </button>
            <button className="primary" disabled={!name.trim() || busy}>
              {busy ? "创建中…" : "创建课程"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ImportModal({
  courses,
  defaultCourse,
  onClose,
  onImported,
  onError,
}: {
  courses: Course[];
  defaultCourse: string;
  onClose: () => void;
  onImported: () => void;
  onError: (message: string) => void;
}) {
  const [course, setCourse] = useState(defaultCourse || courses[0]?.id || "");
  const [selected, setSelected] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  useEffect(() => {
    folder.current?.setAttribute("webkitdirectory", "");
  }, []);
  const supported = selected.filter((file) => /\.(pdf|docx)$/i.test(file.name));
  const upload = async () => {
    setBusy(true);
    try {
      const body = new FormData();
      body.set("course_id", course);
      body.set(
        "paths",
        JSON.stringify(
          supported.map((file) => file.webkitRelativePath || file.name),
        ),
      );
      supported.forEach((file) => body.append("files", file));
      await api("/import-jobs", { method: "POST", body });
      onImported();
    } catch (reason) {
      onError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-heading"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <h2 id="import-heading">导入课程资料</h2>
          <button
            className="icon-button"
            title="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <p>文件会复制到本地资料库，提取文字后即可搜索。</p>
        <label htmlFor="import-course">所属课程</label>
        <select
          id="import-course"
          value={course}
          onChange={(event) => setCourse(event.target.value)}
        >
          {courses.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <div className="import-zone">
          <span className="import-icon">
            <Icon name="upload" size={28} />
          </span>
          <strong>讲义、习题和你的课堂笔记</strong>
          <span>支持 PDF 和 DOCX，可批量选择或导入整个文件夹</span>
          <div>
            <button
              className="secondary"
              onClick={() => files.current?.click()}
            >
              选择文件
            </button>
            <button
              className="secondary"
              onClick={() => folder.current?.click()}
            >
              <Icon name="folder" size={15} />
              选择文件夹
            </button>
          </div>
        </div>
        <input
          hidden
          ref={files}
          type="file"
          multiple
          accept=".pdf,.docx"
          onChange={(event) =>
            setSelected(Array.from(event.target.files || []))
          }
        />
        <input
          hidden
          ref={folder}
          type="file"
          multiple
          onChange={(event) =>
            setSelected(Array.from(event.target.files || []))
          }
        />
        {selected.length > 0 && (
          <div className="selected-files">
            <strong>
              已选择 {supported.length} 份资料{" "}
              <span className="subtle">
                {bytes(supported.reduce((total, file) => total + file.size, 0))}
              </span>
            </strong>
            {supported.slice(0, 4).map((file, index) => (
              <span key={index}>
                <Icon name="file" size={14} />
                {file.webkitRelativePath || file.name}
              </span>
            ))}
            {supported.length > 4 && (
              <small>以及另外 {supported.length - 4} 份资料</small>
            )}
            {supported.length !== selected.length && (
              <small>
                已跳过 {selected.length - supported.length} 个非 PDF / DOCX
                文件。
              </small>
            )}
          </div>
        )}
        <div className="import-note">
          <Icon name="info" size={15} />
          <span>
            扫描件与图片文字暂不支持搜索。需要密码或损坏的文件会单独显示状态，不影响其他资料。
          </span>
        </div>
        <div className="modal-actions">
          <button className="secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !supported.length || !course}
            onClick={() => void upload()}
          >
            {busy
              ? "正在上传本地副本…"
              : `导入${supported.length ? ` ${supported.length} 份资料` : ""}`}
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [category, setCategory] = useState("");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [search, setSearch] = useState<{
    query: string;
    mode: Mode;
    course: string;
    category: string;
  } | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"search" | "library">("search");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectedHit, setSelectedHit] = useState("");
  const [courseModal, setCourseModal] = useState(false);
  const [importModal, setImportModal] = useState(false);
  const [jobPanel, setJobPanel] = useState(false);
  const [infoPanel, setInfoPanel] = useState(false);
  const [toast, setToast] = useState("");
  const [startupError, setStartupError] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const resultList = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const showError = useCallback((message: string) => setToast(message), []);
  const currentCourse = courses.find((course) => course.id === courseId);
  const pending = stats?.pending || 0;

  const loadSettings = useCallback(() => {
    api<Settings>("/settings")
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
    const [courseList, docList, jobList, totals] = await Promise.all([
      api<Course[]>("/courses"),
      api<DocumentRecord[]>("/documents"),
      api<Job[]>("/import-jobs"),
      api<Stats>("/stats"),
    ]);
    setCourses((previous) => {
      if (!previous.length && courseList.length) setCourseId(courseList[0].id);
      return courseList;
    });
    setDocuments(docList);
    setJobs(jobList);
    setStats(totals);
  }, []);
  useEffect(() => {
    if (!settings?.configured) return;
    void refresh().catch((reason) => showError(reason.message));
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void refresh()
        .catch((reason) => showError(reason.message))
        .finally(() => {
          busy = false;
        });
    }, 2500);
    return () => clearInterval(timer);
  }, [settings?.configured, refresh, showError]);

  useEffect(() => {
    generation.current++;
    setLoading(false);
    setResponse(null);
    setSearch(null);
    setSelectedHit("");
  }, [courseId, category]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
      }
      if (event.key === "Escape") {
        setCourseModal(false);
        setImportModal(false);
        setJobPanel(false);
        setInfoPanel(false);
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);

  const runSearch = async (append = false) => {
    const parameters =
      append && search
        ? search
        : { query: query.trim(), mode, course: courseId, category };
    if (!parameters.query) {
      searchInput.current?.focus();
      return;
    }
    const token = ++generation.current;
    setLoading(true);
    setTab("search");
    if (!append) {
      setResponse(null);
      setSelectedHit("");
    }
    const params = new URLSearchParams({
      q: parameters.query,
      mode: parameters.mode,
    });
    if (parameters.course) params.set("course_id", parameters.course);
    if (parameters.category) params.set("category", parameters.category);
    if (append && response?.next_offset != null)
      params.set("offset", String(response.next_offset));
    try {
      const result = await api<SearchResponse>(`/search?${params}`);
      if (token !== generation.current) return;
      setResponse((previous) =>
        append && previous
          ? { ...result, groups: [...previous.groups, ...result.groups] }
          : result,
      );
      setSearch(parameters);
    } catch (reason) {
      if (token === generation.current) showError((reason as Error).message);
    } finally {
      if (token === generation.current) setLoading(false);
    }
  };

  const openHit = (group: Group, hit: Hit) => {
    const doc = documents.find((item) => item.id === group.document_id);
    if (!doc || doc.version !== group.version) {
      showError("资料已更新，请重新搜索。");
      return;
    }
    setSelectedHit(hit.unit_id);
    setSelection({
      document: doc,
      hit,
      query: search?.query,
      mode: search?.mode,
    });
  };
  const loadMoreUnits = async (group: Group) => {
    if (!search || group.next_unit_offset == null) return;
    const token = generation.current;
    const params = new URLSearchParams({
      q: search.query,
      mode: search.mode,
      document_id: group.document_id,
      unit_offset: String(group.next_unit_offset),
    });
    try {
      const result = await api<SearchResponse>(`/search?${params}`);
      const added = result.groups[0];
      if (token !== generation.current || !added) return;
      setResponse(
        (previous) =>
          previous && {
            ...previous,
            groups: previous.groups.map((item) =>
              item.document_id === group.document_id
                ? { ...added, hits: [...item.hits, ...added.hits] }
                : item,
            ),
          },
      );
    } catch (reason) {
      showError((reason as Error).message);
    }
  };
  const rebuild = async (id: string) => {
    try {
      await api(`/documents/${id}/rebuild`, { method: "POST" });
      await refresh();
      setJobPanel(true);
    } catch (reason) {
      showError((reason as Error).message);
    }
  };
  const filteredDocuments = documents.filter(
    (doc) =>
      (!courseId || doc.course_id === courseId) &&
      (!category || doc.category === category),
  );
  const flatHits =
    response?.groups.flatMap((group) =>
      group.hits.map((hit) => ({ group, hit })),
    ) || [];
  const resultKeys = (event: React.KeyboardEvent) => {
    if (
      !["ArrowDown", "ArrowUp", "Enter"].includes(event.key) ||
      !flatHits.length
    )
      return;
    event.preventDefault();
    const index = flatHits.findIndex(
      (item) => item.hit.unit_id === selectedHit,
    );
    if (event.key === "Enter") {
      const selected = flatHits[Math.max(0, index)];
      openHit(selected.group, selected.hit);
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
  const beginImport = () => {
    if (!courses.length) setCourseModal(true);
    else setImportModal(true);
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
        <Setup settings={settings} onDone={loadSettings} onError={showError} />
      ) : (
        <div className="app-shell">
          <aside className="sidebar">
            <a className="brand" href="/" aria-label="书间首页">
              <span className="brand-icon">
                <Icon name="book" size={21} />
              </span>
              <span>
                书间<small>COURSE SEARCH</small>
              </span>
            </a>
            <div className="sidebar-section-heading">
              <span>我的课程</span>
              <button
                className="icon-button"
                title="新建课程"
                onClick={() => setCourseModal(true)}
              >
                <Icon name="plus" size={16} />
              </button>
            </div>
            <nav className="course-nav">
              <button
                className={!courseId ? "nav-item active" : "nav-item"}
                onClick={() => setCourseId("")}
              >
                <Icon name="grid" size={17} />
                <span>全部课程</span>
                <small>{documents.length}</small>
              </button>
              {courses.map((course, index) => (
                <button
                  className={
                    courseId === course.id ? "nav-item active" : "nav-item"
                  }
                  key={course.id}
                  onClick={() => setCourseId(course.id)}
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
                className={!category ? "category-item active" : "category-item"}
                onClick={() => setCategory("")}
              >
                <Icon name="folder" size={16} />
                <span>所有资料</span>
              </button>
              {categories.map((item) => (
                <button
                  className={
                    category === item ? "category-item active" : "category-item"
                  }
                  key={item}
                  onClick={() => setCategory(item)}
                >
                  <span className={`category-dot ${item.toLowerCase()}`} />
                  <span>{categoryNames[item]}</span>
                  <small>
                    {
                      documents.filter(
                        (doc) =>
                          doc.category === item &&
                          (!courseId || doc.course_id === courseId),
                      ).length
                    }
                  </small>
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <button
                className="index-status"
                onClick={() => setJobPanel(true)}
              >
                <span className={pending ? "spinner small" : "status-dot"} />
                <span>
                  {pending ? `${pending} 份资料正在处理` : "本地索引已就绪"}
                </span>
                <Icon name="arrow" size={13} />
              </button>
              <button className="storage" onClick={() => setInfoPanel(true)}>
                <Icon name="lock" size={14} />
                <span>
                  仅存储于本机
                  <small>
                    {stats ? bytes(stats.storage_bytes) : "…"} · 查看资料库
                  </small>
                </span>
                <Icon name="info" size={15} />
              </button>
            </div>
          </aside>
          <div className="workspace">
            <header className="workspace-header">
              <div>
                <span className="breadcrumb">资料工作台</span>
                <Icon name="arrow" size={13} />
                <strong>{currentCourse?.name || "全部课程"}</strong>
              </div>
              <span className="offline-badge">
                <span className="status-dot" />
                离线可用
              </span>
              <button className="primary import-button" onClick={beginImport}>
                <Icon name="plus" size={16} />
                导入资料
              </button>
            </header>
            <section className="search-area">
              <div className="search-heading">
                <h1>在资料中，找到答案的出处。</h1>
                <span>
                  {currentCourse?.name || "所有课程"}
                  <span className="dot">·</span>
                  {filteredDocuments.length} 份资料
                </span>
              </div>
              <form
                className="search-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runSearch();
                }}
              >
                <Icon name="search" size={21} />
                <input
                  ref={searchInput}
                  aria-label="搜索课程资料"
                  placeholder="输入术语或短语，例如 deadlock"
                  value={query}
                  maxLength={500}
                  onChange={(event) => setQuery(event.target.value)}
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
                  disabled={loading || !query.trim()}
                >
                  {loading ? <span className="spinner small light" /> : "搜索"}
                  <Icon name="arrow" size={16} />
                </button>
              </form>
              <div className="search-options">
                <div className="mode-switch" aria-label="搜索模式">
                  {(Object.keys(modeNames) as Mode[]).map((item) => (
                    <button
                      key={item}
                      className={mode === item ? "active" : ""}
                      onClick={() => setMode(item)}
                    >
                      {modeNames[item]}
                    </button>
                  ))}
                </div>
                <span>
                  <Icon name="info" size={13} />
                  {mode === "phrase"
                    ? "连续匹配完整短语，不跨页或段落"
                    : mode === "all"
                      ? "同一页或段落包含全部搜索词"
                      : "包含任一搜索词即可命中"}
                </span>
              </div>
            </section>
            <main className="content-grid">
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
                    onClick={() => setJobPanel(true)}
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
                            <span>“{search?.query}”</span>
                            <small>
                              {response.total_documents} 个文件 ·{" "}
                              {response.total_hits} 处命中
                            </small>
                          </div>
                          {!response.groups.length && (
                            <div className="empty-results">
                              <div className="empty-icon">
                                <Icon name="search" size={28} />
                              </div>
                              <h3>没有找到匹配内容</h3>
                              <p>
                                试试更短的术语，或切换“任一词”。
                                <br />
                                扫描件、图片文字和词形变化不参与匹配。
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
                                <button
                                  data-hit={hit.unit_id}
                                  key={hit.unit_id}
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
                                </button>
                              ))}
                              {group.next_unit_offset != null && (
                                <button
                                  className="text-button more-units"
                                  onClick={() => void loadMoreUnits(group)}
                                >
                                  加载本文件更多位置 ({group.hits.length}/
                                  {group.unit_total})
                                  <Icon name="down" size={13} />
                                </button>
                              )}
                            </article>
                          ))}
                          {response.next_offset != null && (
                            <button
                              className="secondary more-results"
                              disabled={loading}
                              onClick={() => void runSearch(true)}
                            >
                              {loading ? "加载中…" : "加载更多文件"}
                            </button>
                          )}
                        </>
                      ) : (
                        <div className="empty-results idle">
                          <div className="empty-icon">
                            <Icon name="search" size={28} />
                          </div>
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
                                setQuery("deadlock");
                                searchInput.current?.focus();
                              }}
                            >
                              deadlock
                            </button>
                            <button
                              onClick={() => {
                                setQuery("mutual exclusion");
                                setMode("phrase");
                                searchInput.current?.focus();
                              }}
                            >
                              mutual exclusion
                            </button>
                          </div>
                          {!documents.length && (
                            <button
                              className="text-button"
                              onClick={beginImport}
                            >
                              先导入你的课程资料
                              <Icon name="arrow" size={14} />
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="results-summary">
                        <span>本地资料</span>
                        <small>{filteredDocuments.length} 个文件</small>
                      </div>
                      {!filteredDocuments.length ? (
                        <div className="empty-results">
                          <div className="empty-icon">
                            <Icon name="folder" size={28} />
                          </div>
                          <h3>这里还没有资料</h3>
                          <p>导入课程讲义和笔记，建立你的检索库。</p>
                          <button className="secondary" onClick={beginImport}>
                            导入资料
                          </button>
                        </div>
                      ) : (
                        filteredDocuments.map((doc) => (
                          <article
                            className={`document-card ${selection?.document.id === doc.id ? "selected" : ""}`}
                            key={doc.id}
                          >
                            <button
                              className="document-open"
                              onClick={() => setSelection({ document: doc })}
                            >
                              <span className={`file-label ${doc.kind}`}>
                                {doc.kind.toUpperCase()}
                              </span>
                              <div>
                                <strong title={doc.relative_path}>
                                  {doc.name}
                                </strong>
                                <span>
                                  {doc.course_name} ·{" "}
                                  {doc.kind === "pdf"
                                    ? `${doc.searchable_count}/${doc.unit_count} 页可搜索`
                                    : `${doc.searchable_count} 个可搜索单元`}
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
                                value={doc.category}
                                onChange={async (event) => {
                                  try {
                                    await api(`/documents/${doc.id}`, {
                                      method: "PATCH",
                                      body: JSON.stringify({
                                        category: event.target.value,
                                      }),
                                    });
                                    await refresh();
                                  } catch (reason) {
                                    showError((reason as Error).message);
                                  }
                                }}
                              >
                                {categories.map((item) => (
                                  <option key={item}>{item}</option>
                                ))}
                              </select>
                              <span>{bytes(doc.size)}</span>
                              <button
                                className="icon-button"
                                title="重新建立索引"
                                onClick={() => void rebuild(doc.id)}
                              >
                                <Icon name="refresh" size={14} />
                              </button>
                            </div>
                          </article>
                        ))
                      )}
                    </>
                  )}
                </div>
                <div className="results-footer">
                  <span>↑ ↓ 选择</span>
                  <span>Enter 打开原文</span>
                </div>
              </section>
              <Reader
                selection={selection}
                onClose={() => setSelection(null)}
                onError={showError}
                onRebuild={(id) => void rebuild(id)}
              />
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
              setCourseId(created.id);
              setCourseModal(false);
            } catch (reason) {
              showError((reason as Error).message);
            }
          }}
        />
      )}
      {importModal && (
        <ImportModal
          courses={courses}
          defaultCourse={courseId}
          onClose={() => setImportModal(false)}
          onError={showError}
          onImported={() => {
            setImportModal(false);
            setJobPanel(true);
            void refresh();
          }}
        />
      )}
      {jobPanel && (
        <div className="drawer-backdrop" onClick={() => setJobPanel(false)}>
          <section
            className="jobs-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="导入与索引"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">LOCAL INDEX</span>
                <h2>导入与索引</h2>
              </div>
              <button
                className="icon-button"
                title="关闭导入任务"
                onClick={() => setJobPanel(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <p className="drawer-intro">
              每份资料独立处理。失败文件不会影响已有索引。
            </p>
            <div className="jobs-list">
              {!jobs.length && (
                <div className="empty-results">
                  <Icon name="folder" size={30} />
                  <h3>还没有导入记录</h3>
                  <button
                    className="secondary"
                    onClick={() => {
                      setJobPanel(false);
                      beginImport();
                    }}
                  >
                    导入第一份资料
                  </button>
                </div>
              )}
              {jobs.map((job) => (
                <article className="job-card" data-job={job.id} key={job.id}>
                  <div className="job-title">
                    <strong>{job.course_name}</strong>
                    <span>
                      {job.completed} / {job.total}
                      {job.done ? " 已处理" : " 处理中"}
                    </span>
                  </div>
                  <div className="progress-track">
                    <span
                      style={{
                        width: `${job.total ? (job.completed / job.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <small className="job-date">
                    {new Date(job.created_at).toLocaleString("zh-CN")}
                  </small>
                  {job.items.map((item) => (
                    <div className="job-item" key={item.id}>
                      <Icon
                        name={
                          item.status === "ready" || item.status === "duplicate"
                            ? "check"
                            : item.status === "processing" ||
                                item.status === "queued"
                              ? "refresh"
                              : "info"
                        }
                        size={15}
                      />
                      <div>
                        <strong title={item.relative_path}>
                          {item.relative_path}
                        </strong>
                        <span className={`status-text ${item.status}`}>
                          {statusLabels[item.status]}
                        </span>
                        {item.error && <p>{item.error}</p>}
                      </div>
                      {["failed", "password_required", "conflict"].includes(
                        item.status,
                      ) && (
                        <button
                          className={
                            item.status === "conflict"
                              ? "replace-button"
                              : "text-button"
                          }
                          onClick={async () => {
                            try {
                              await api(
                                `/import-jobs/${job.id}/items/${item.id}/retry`,
                                {
                                  method: "POST",
                                  body: JSON.stringify({
                                    replace_existing:
                                      item.status === "conflict",
                                  }),
                                },
                              );
                              await refresh();
                            } catch (reason) {
                              showError((reason as Error).message);
                            }
                          }}
                        >
                          {item.status === "conflict" ? "确认替换" : "重试"}
                        </button>
                      )}
                    </div>
                  ))}
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
      {infoPanel && (
        <div className="modal-backdrop" onClick={() => setInfoPanel(false)}>
          <section
            className="modal small-modal"
            role="dialog"
            aria-modal="true"
            aria-label="本地资料库"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>你的本地资料库</h2>
              <button
                className="icon-button"
                title="关闭"
                onClick={() => setInfoPanel(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <p>文件副本、文字索引和导入记录均保存在以下目录。</p>
            <code className="library-path">
              {stats?.library_path || settings.library_path}
            </code>
            <div className="library-metrics">
              <span>
                <strong>{stats?.documents || 0}</strong>份资料
              </span>
              <span>
                <strong>{stats?.searchable_units || 0}</strong>可搜索单元
              </span>
              <span>
                <strong>{bytes(stats?.storage_bytes || 0)}</strong>本地占用
              </span>
            </div>
            <p className="subtle">
              备份前请先关闭本地服务，再复制整个目录。V1
              为英文术语与短语检索、中文连续字串检索；不含 OCR 或生成答案。
            </p>
            <div className="local-promise">
              <Icon name="lock" size={14} /> 页面与检索不连接外部服务
            </div>
          </section>
        </div>
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
