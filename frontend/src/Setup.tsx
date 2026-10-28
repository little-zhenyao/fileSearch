import { useEffect, useRef, useState } from "react";
import { api, bytes, type Course } from "./types";
import { Icon } from "./icons";

export type Settings = {
  configured: boolean;
  library_path: string;
  suggested_path: string;
};

export function Setup({
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

export function CourseModal({
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

export function ImportModal({
  courses,
  defaultCourse,
  onClose,
  onImported,
  onError,
}: {
  courses: Course[];
  defaultCourse: string;
  onClose: () => void;
  onImported: (courseId: string) => void;
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
      onImported(course);
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
