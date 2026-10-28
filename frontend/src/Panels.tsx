import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  statusLabels,
  type Bookmark,
  type Course,
  type ExamState,
  type HistoryEntry,
  type Job,
  type Preferences,
  type PreflightReport,
  type ReadingPosition,
  type SearchContext,
  type VocabularyEntry,
} from "./types";
import { Icon } from "./icons";

export function Dialog({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal v2-dialog ${wide ? "wide-dialog" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label={`关闭${title}`}
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function SavedPanel({
  kind,
  courses,
  course,
  open,
  rebindPosition,
  close,
  error,
}: {
  kind: "history" | "bookmarks";
  courses: Course[];
  course: string;
  open: (
    context: SearchContext | null,
    bookmark?: Bookmark,
    other?: boolean,
  ) => void;
  rebindPosition?: ReadingPosition;
  close: () => void;
  error: (message: string) => void;
}) {
  const [items, setItems] = useState<Bookmark[]>([]),
    [history, setHistory] = useState<HistoryEntry[]>([]);
  const [scope, setScope] = useState(course),
    [tag, setTag] = useState(""),
    [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const loadGeneration = useRef(0);
  const load = async () => {
    const token = ++loadGeneration.current;
    try {
      if (kind === "history") {
        const next = await api<HistoryEntry[]>("/history");
        if (token === loadGeneration.current) setHistory(next);
      } else {
        const params = new URLSearchParams();
        if (scope) params.set("course_id", scope);
        if (tag) params.set("tag", tag);
        if (query) params.set("q", query);
        const next = await api<Bookmark[]>(`/bookmarks?${params}`);
        if (token === loadGeneration.current) setItems(next);
      }
    } catch (reason) {
      if (token === loadGeneration.current) error((reason as Error).message);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [kind, scope, tag, query]);
  return (
    <Dialog
      title={kind === "history" ? "搜索历史" : "收藏与标签"}
      close={close}
      wide
    >
      {kind === "history" ? (
        <>
          <p className="subtle">最近 100 条搜索，点击后按当前资料重新检索。</p>
          <button
            className="text-button"
            onClick={() => {
              void api("/history", { method: "DELETE" })
                .then(load)
                .catch((reason) => error(reason.message));
            }}
          >
            清空搜索历史
          </button>
          <div className="saved-list">
            {history.map((item) => (
              <button
                className="saved-item"
                key={item.id}
                onClick={() => open(item.context)}
              >
                <strong>{item.context.query}</strong>
                <span>
                  {courses.find((c) => c.id === item.context.course)?.name ||
                    "全部课程"}{" "}
                  ·{" "}
                  {item.context.mode === "phrase"
                    ? "完整短语"
                    : item.context.mode === "any"
                      ? "任一词"
                      : "全部词"}
                  {item.context.expand ? " · 扩展" : ""}
                </span>
                <small>
                  {new Date(item.updated_at).toLocaleString("zh-CN")}
                </small>
              </button>
            ))}
            {!history.length && <p>还没有搜索历史。</p>}
          </div>
        </>
      ) : (
        <>
          <div className="panel-filters">
            <select
              aria-label="收藏课程"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">全部课程</option>
              {courses.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              aria-label="筛选收藏标签"
              placeholder="标签（精确匹配）"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            />
            <input
              aria-label="搜索收藏备注"
              placeholder="备注、文件或标签"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="saved-list">
            {items.map((item) => (
              <article className="saved-item" key={item.id}>
                <strong>
                  {item.name} · {item.position.label}
                </strong>
                <span>
                  {item.course_name} · {item.tags.join(" · ")}
                </span>
                <p>{item.note || item.position.excerpt}</p>
                {item.status !== "resolved" && (
                  <p className="stale-location">
                    位置待确认：资料已替换或原位置不可用。备注仍保留。
                  </p>
                )}
                <div className="inline-actions">
                  <button
                    disabled={item.status !== "resolved"}
                    onClick={() => open(null, item)}
                  >
                    打开收藏
                  </button>
                  <button
                    disabled={item.status !== "resolved"}
                    onClick={() => open(null, item, true)}
                  >
                    在另一栏打开
                  </button>
                  <button onClick={() => setEditing(item)}>
                    编辑备注和标签
                  </button>
                  {item.status !== "resolved" && (
                    <button
                      disabled={
                        rebindPosition?.document_id !== item.document_id
                      }
                      onClick={() => {
                        void api(`/bookmarks/${item.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            position: rebindPosition,
                            note: item.note,
                            tags: item.tags,
                          }),
                        })
                          .then(load)
                          .catch((reason) => error(reason.message));
                      }}
                    >
                      绑定到当前阅读位置
                    </button>
                  )}
                  <button
                    onClick={() => {
                      void api(`/bookmarks/${item.id}`, { method: "DELETE" })
                        .then(load)
                        .catch((reason) => error(reason.message));
                    }}
                  >
                    删除收藏
                  </button>
                </div>
              </article>
            ))}
            {!items.length && <p>没有符合条件的收藏。</p>}
          </div>
        </>
      )}
      {editing && (
        <BookmarkEditor
          bookmark={editing}
          close={() => setEditing(null)}
          saved={() => {
            setEditing(null);
            void load();
          }}
          error={error}
        />
      )}
    </Dialog>
  );
}

export function BookmarkEditor({
  position,
  bookmark,
  close,
  saved,
  error,
}: {
  position?: ReadingPosition;
  bookmark?: Bookmark;
  close: () => void;
  saved: () => void;
  error: (message: string) => void;
}) {
  const [note, setNote] = useState(bookmark?.note ?? ""),
    [tags, setTags] = useState(bookmark?.tags.join(", ") ?? ""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog title={bookmark ? "编辑收藏" : "收藏当前位置"} close={close}>
      <p>
        {position?.label ||
          bookmark?.position.label ||
          (position?.page ? `第 ${position.page} 页` : "当前段落或表格单元")}
      </p>
      <form
        className="v2-form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void api(bookmark ? `/bookmarks/${bookmark.id}` : "/bookmarks", {
            method: bookmark ? "PATCH" : "POST",
            body: JSON.stringify({
              position: bookmark ? undefined : position,
              note,
              tags: tags
                .split(/[,，]/)
                .map((t) => t.trim())
                .filter(Boolean),
            }),
          })
            .then(saved)
            .catch((reason) => error(reason.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          备注
          <textarea
            aria-label="收藏备注"
            maxLength={10000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={5}
          />
        </label>
        <label>
          标签（逗号分隔）
          <input
            aria-label="收藏标签"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "保存中…" : "保存收藏"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const shortcutNames: Record<string, string> = {
  search: "聚焦搜索",
  back: "返回位置",
  forward: "前进位置",
  bookmark: "收藏当前位置",
  pane1: "切换阅读区 1",
  pane2: "切换阅读区 2",
};
export function shortcutValue(
  event: Pick<
    KeyboardEvent,
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key" | "code"
  >,
) {
  const key = /^Digit[12]$/.test(event.code)
    ? event.code
    : event.key.length === 1
      ? event.key.toLowerCase()
      : event.key;
  return [
    event.metaKey && "Meta",
    event.ctrlKey && "Control",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
export function shortcutLabel(value: string) {
  return value
    .replace("Meta+", "⌘ ")
    .replace("Control+", "⌃ ")
    .replace("Alt+", "⌥ ")
    .replace("Shift+", "⇧ ")
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("Digit", "");
}

export function PreferencesPanel({
  preferences,
  courses,
  frozen,
  close,
  saved,
  error,
}: {
  preferences: Preferences;
  courses: Course[];
  frozen: boolean;
  close: () => void;
  saved: (value: Preferences) => void;
  error: (message: string) => void;
}) {
  const [value, setValue] = useState(preferences),
    [vocabulary, setVocabulary] = useState<VocabularyEntry[]>([]),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<VocabularyEntry[]>("/vocabulary")
      .then(setVocabulary)
      .catch((reason) => error(reason.message));
  }, [error]);
  return (
    <Dialog title="快捷键与搜索设置" close={close} wide>
      <div className="v2-form">
        <p className="subtle">
          方向键选择结果，Enter
          打开；输入框内保留文字编辑操作。点击快捷键输入框后按下新组合键。
        </p>
        <div className="shortcut-grid">
          {Object.entries(value.shortcuts).map(([key, combo]) => (
            <label key={key}>
              {shortcutNames[key]}
              <input
                aria-label={`${shortcutNames[key]}快捷键`}
                readOnly
                disabled={frozen}
                value={shortcutLabel(combo)}
                onKeyDown={(event) => {
                  event.preventDefault();
                  if (["Meta", "Control", "Alt", "Shift"].includes(event.key))
                    return;
                  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
                    error("请使用 ⌘、⌃ 或 ⌥ 组合键。");
                    return;
                  }
                  const next = shortcutValue(event.nativeEvent);
                  if (
                    Object.entries(value.shortcuts).some(
                      ([action, existing]) =>
                        action !== key && existing === next,
                    )
                  ) {
                    error("此快捷键已用于其他操作。");
                    return;
                  }
                  setValue({
                    ...value,
                    shortcuts: { ...value.shortcuts, [key]: next },
                  });
                }}
              />
            </label>
          ))}
        </div>
        <h3>类别优先顺序</h3>
        <div className="priority-list">
          {value.category_order.map((category, index) => (
            <div key={category}>
              <span>
                {index + 1}. {category}
              </span>
              <button
                disabled={frozen || index === 0}
                onClick={() => {
                  const order = [...value.category_order];
                  [order[index - 1], order[index]] = [
                    order[index],
                    order[index - 1],
                  ];
                  setValue({ ...value, category_order: order });
                }}
              >
                上移
              </button>
            </div>
          ))}
        </div>
        <button
          className="secondary"
          disabled={frozen}
          onClick={() => {
            void api<Preferences>("/preferences", {
              method: "PUT",
              body: JSON.stringify(value),
            })
              .then((updated) => {
                saved(updated);
                error("设置已保存。");
              })
              .catch((reason) => error(reason.message));
          }}
        >
          保存快捷键与排序
        </button>
        <h3>本地词表</h3>
        <p className="subtle">
          每行一个等价词组，用英文分号分隔。仅直接扩展，不沿其他词组继续扩展。课程词组仅作用于所属课程。
        </p>
        <div className="vocabulary-list">
          {vocabulary.map((entry, index) => (
            <div className="vocabulary-row" key={entry.id ?? index}>
              <select
                aria-label={`词组${index + 1}类型`}
                disabled={frozen}
                value={entry.kind}
                onChange={(e) =>
                  setVocabulary(
                    vocabulary.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            kind: e.target.value as VocabularyEntry["kind"],
                          }
                        : item,
                    ),
                  )
                }
              >
                <option value="form">词形</option>
                <option value="synonym">同义词</option>
              </select>
              <select
                aria-label={`词组${index + 1}课程`}
                disabled={frozen}
                value={entry.course_id ?? ""}
                onChange={(e) =>
                  setVocabulary(
                    vocabulary.map((item, i) =>
                      i === index
                        ? { ...item, course_id: e.target.value || null }
                        : item,
                    ),
                  )
                }
              >
                <option value="">所有课程</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <input
                aria-label={`词组${index + 1}内容`}
                disabled={frozen}
                value={entry.terms.join(";")}
                onChange={(e) =>
                  setVocabulary(
                    vocabulary.map((item, i) =>
                      i === index
                        ? { ...item, terms: e.target.value.split(";") }
                        : item,
                    ),
                  )
                }
              />
              <button
                disabled={frozen}
                aria-label={`删除词组${index + 1}`}
                onClick={() =>
                  setVocabulary(vocabulary.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="inline-actions">
          <button
            disabled={frozen || vocabulary.length >= 100}
            onClick={() =>
              setVocabulary([
                ...vocabulary,
                {
                  id: crypto.randomUUID(),
                  kind: "synonym",
                  course_id: null,
                  terms: ["", ""],
                },
              ])
            }
          >
            添加词组
          </button>
          <button
            className="primary"
            disabled={frozen || busy}
            onClick={() => {
              setBusy(true);
              void api<VocabularyEntry[]>("/vocabulary", {
                method: "PUT",
                body: JSON.stringify(vocabulary),
              })
                .then((entries) => {
                  setVocabulary(entries);
                  error("词表已保存，请重新搜索以应用。");
                })
                .catch((reason) => error(reason.message))
                .finally(() => setBusy(false));
            }}
          >
            保存词表
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function ExamPanel({
  course,
  exam,
  changed,
  close,
  error,
}: {
  course: string;
  exam: ExamState;
  changed: (state: ExamState) => void;
  close: () => void;
  error: (message: string) => void;
}) {
  const [report, setReport] = useState<PreflightReport | null>(null),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false);
  useEffect(() => {
    void api<PreflightReport | null>(
      `/preflight${course ? `?course_id=${course}` : ""}`,
    )
      .then(setReport)
      .catch((reason) => error(reason.message));
  }, [course, error]);
  const check = () => {
    setBusy(true);
    setAck(false);
    void api<PreflightReport>("/preflight", {
      method: "POST",
      body: JSON.stringify({ course_id: course || null }),
    })
      .then(setReport)
      .catch((reason) => error(reason.message))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog title="考试自检" close={close} wide>
      <p>
        检查所选课程的本地副本、索引、可阅读性和导入问题。外部原文件的变化不在检查范围内。
      </p>
      {exam.active ? (
        <div>
          <p className="exam-active">
            考试模式已开启。搜索、阅读和个人标注可用，资料与设置已冻结。
          </p>
          <button
            className="secondary"
            onClick={() => {
              void api<ExamState>("/exam/exit", { method: "POST" })
                .then(changed)
                .catch((reason) => error(reason.message));
            }}
          >
            退出考试模式
          </button>
        </div>
      ) : (
        <button className="primary" disabled={busy} onClick={check}>
          {busy ? "正在核验文件与索引…" : "执行考前自检"}
        </button>
      )}
      {report && (
        <div className="preflight-report">
          <p>
            {new Date(report.created_at).toLocaleString("zh-CN")} ·{" "}
            {report.documents.length} 份资料
            {report.stale && (
              <strong className="stale-location"> · 已变化，需重新自检</strong>
            )}
          </p>
          <h3>阻断问题 {report.blockers.length}</h3>
          {report.blockers.map((issue, index) => (
            <div className="preflight-issue" key={index}>
              <strong>{issue.name}</strong>
              <p>{issue.message}</p>
              {issue.item_id && (
                <button
                  disabled={exam.active || busy}
                  onClick={() => {
                    setBusy(true);
                    void api(
                      `/import-jobs/${issue.job_id}/items/${issue.item_id}/dismiss`,
                      { method: "POST" },
                    )
                      .then(() => {
                        setBusy(false);
                        check();
                      })
                      .catch((reason) => {
                        setBusy(false);
                        error(reason.message);
                      });
                  }}
                >
                  确认排除此导入项并重新自检
                </button>
              )}
            </div>
          ))}
          <h3>可确认警告 {report.warnings.length}</h3>
          {report.warnings.map((issue, index) => (
            <p key={index}>
              {issue.name}：{issue.message}
            </p>
          ))}
          <div className="preflight-documents">
            {report.documents.map((doc) => (
              <div key={doc.id}>
                <span>
                  {doc.ok ? "✓" : "!"} {doc.name}
                </span>
                <small>
                  v{doc.version} · {doc.searchable_count}/{doc.unit_count}{" "}
                  可搜索 · {new Date(doc.indexed_at).toLocaleString("zh-CN")}
                </small>
              </div>
            ))}
          </div>
          {!!report.warnings.length && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              我已确认以上可搜索范围和警告
            </label>
          )}
          {!exam.active && (
            <button
              className="primary"
              disabled={
                busy ||
                report.stale ||
                !!report.blockers.length ||
                (!!report.warnings.length && !ack)
              }
              onClick={() => {
                setBusy(true);
                void api<ExamState>("/exam/enter", {
                  method: "POST",
                  body: JSON.stringify({
                    report_id: report.id,
                    acknowledge_warnings: ack,
                  }),
                })
                  .then(changed)
                  .catch((reason) => {
                    setReport({ ...report, stale: true });
                    error(reason.message);
                  })
                  .finally(() => setBusy(false));
              }}
            >
              进入考试模式并冻结资料
            </button>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function JobsPanel({
  jobs,
  frozen,
  close,
  refresh,
  error,
}: {
  jobs: Job[];
  frozen: boolean;
  close: () => void;
  refresh: () => Promise<void>;
  error: (message: string) => void;
}) {
  return (
    <div className="drawer-backdrop" onClick={close}>
      <section
        className="jobs-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="导入与索引"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <h2>导入与索引</h2>
          <button className="icon-button" title="关闭导入任务" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <p>每份资料独立处理。失败文件不会影响已有索引。</p>
        <div className="jobs-list">
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
              {job.items.map((item) => (
                <div className="job-item" key={item.id}>
                  <Icon name={item.status === "ready" ? "check" : "info"} />
                  <div>
                    <strong>{item.relative_path}</strong>
                    <span className={`status-text ${item.status}`}>
                      {statusLabels[item.status]}
                    </span>
                    {item.error && <p>{item.error}</p>}
                  </div>
                  {["failed", "password_required", "conflict"].includes(
                    item.status,
                  ) && (
                    <button
                      disabled={frozen}
                      className="text-button"
                      onClick={() => {
                        void api(
                          `/import-jobs/${job.id}/items/${item.id}/retry`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              replace_existing: item.status === "conflict",
                            }),
                          },
                        )
                          .then(refresh)
                          .catch((reason) => error(reason.message));
                      }}
                    >
                      {item.status === "conflict" ? "确认替换" : "重试"}
                    </button>
                  )}
                </div>
              ))}
            </article>
          ))}
          {!jobs.length && <p>还没有导入记录。</p>}
        </div>
      </section>
    </div>
  );
}
