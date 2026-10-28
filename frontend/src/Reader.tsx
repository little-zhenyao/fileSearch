import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import {
  api,
  type PreviewUnit,
  type Selection,
  type Unit,
  type ReadingPosition,
} from "./types";
import { Highlight } from "./Highlight";
import { Icon } from "./icons";

GlobalWorkerOptions.workerSrc = workerUrl;

function PdfPage({
  pdf,
  number,
  width,
  zoom,
  rotation,
  active,
  current,
  navigation,
  find,
  scroller,
  onLocated,
  autoLocate,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
  zoom: number;
  rotation: number;
  active: Unit | null;
  current: number;
  navigation: number;
  find: string;
  scroller: React.RefObject<HTMLDivElement | null>;
  onLocated: (number: number) => void;
  autoLocate: boolean;
}) {
  const outer = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textContainer = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [error, setError] = useState("");
  const isTarget = active?.anchor.page === number;
  const locatedToken = useRef("");
  const totalRotation = page ? (page.rotate + rotation) % 360 : rotation;
  const base = page?.getViewport({ scale: 1, rotation: totalRotation });
  const viewport = page?.getViewport({
    scale: (width / (base?.width || 612)) * zoom,
    rotation: totalRotation,
  });
  const scale = viewport?.scale || 1;
  const targetToken = isTarget
    ? `${active.unit_id}:${current}:${navigation}:${scale}:${totalRotation}`
    : "";
  const displayWidth = viewport?.width || width * zoom;
  const displayHeight = viewport?.height || width * zoom * 1.414;

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[0].isIntersecting),
      {
        root: scroller.current,
        rootMargin: "700px",
      },
    );
    if (outer.current) observer.observe(outer.current);
    return () => observer.disconnect();
  }, [scroller]);

  useEffect(() => {
    if (!visible && !isTarget) return;
    let cancelled = false;
    pdf
      .getPage(number)
      .then((value) => {
        if (!cancelled) setPage(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [pdf, number, visible, isTarget]);

  useEffect(() => {
    if (!visible || !page || !canvas.current || !textContainer.current) return;
    const view = page.getViewport({ scale, rotation: totalRotation });
    const element = canvas.current;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    element.width = Math.floor(view.width * ratio);
    element.height = Math.floor(view.height * ratio);
    const context = element.getContext("2d");
    if (!context) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    let layer: TextLayer | undefined;
    setError("");
    const container = textContainer.current;
    container.replaceChildren();
    const render = async () => {
      task = page.render({
        canvasContext: context,
        viewport: view,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      await task.promise;
      if (cancelled) return;
      layer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport: view,
      });
      await layer.render();
      if (cancelled) return;
      if (find.trim()) {
        const needle = find.normalize("NFKC").toLocaleLowerCase();
        for (const span of container.querySelectorAll("span")) {
          if (
            span.textContent
              ?.normalize("NFKC")
              .toLocaleLowerCase()
              .includes(needle)
          )
            span.classList.add("fallback-match");
        }
      }
      if (
        autoLocate &&
        isTarget &&
        locatedToken.current !== targetToken &&
        outer.current &&
        scroller.current
      ) {
        locatedToken.current = targetToken;
        const rect = active?.rectangles?.[current]?.[0];
        const converted = rect ? view.convertToViewportRectangle(rect) : null;
        const y = converted ? Math.min(converted[1], converted[3]) : 0;
        const outerRect = outer.current.getBoundingClientRect();
        const scrollRect = scroller.current.getBoundingClientRect();
        scroller.current.scrollTo({
          top:
            scroller.current.scrollTop +
            outerRect.top -
            scrollRect.top +
            y -
            100,
          behavior: "instant",
        });
        onLocated(number);
      }
    };
    void render().catch((reason) => {
      if (!cancelled && reason?.name !== "RenderingCancelledException")
        setError("页面渲染失败，请重试打开资料。");
    });
    return () => {
      cancelled = true;
      task?.cancel();
      layer?.cancel();
      element.width = 0;
      element.height = 0;
      container.replaceChildren();
    };
  }, [page, visible, scale, totalRotation, find, targetToken, autoLocate]);

  useEffect(() => {
    if (autoLocate && isTarget && targetToken !== locatedToken.current) {
      outer.current?.scrollIntoView({ block: "start", behavior: "instant" });
    }
  }, [targetToken, isTarget, autoLocate]);

  return (
    <div
      className="pdf-sheet"
      ref={outer}
      data-page={number}
      style={{ width: displayWidth, height: displayHeight }}
    >
      {visible ? (
        <>
          <canvas
            ref={canvas}
            style={{ width: displayWidth, height: displayHeight }}
          />
          <div
            ref={textContainer}
            className="textLayer"
            style={
              {
                "--scale-factor": scale,
                "--total-scale-factor": scale * (page?.userUnit || 1),
                "--scale-round-x": "1px",
                "--scale-round-y": "1px",
              } as React.CSSProperties
            }
          />
          {isTarget && viewport && (
            <div className="pdf-highlights">
              {active.rectangles?.flatMap((rects, hitIndex) =>
                rects.map((rect, rectIndex) => {
                  const r = viewport.convertToViewportRectangle(rect);
                  return (
                    <div
                      key={`${hitIndex}-${rectIndex}`}
                      className={
                        hitIndex === current
                          ? "pdf-highlight active"
                          : "pdf-highlight"
                      }
                      style={{
                        left: Math.min(r[0], r[2]),
                        top: Math.min(r[1], r[3]),
                        width: Math.abs(r[2] - r[0]),
                        height: Math.abs(r[3] - r[1]),
                      }}
                    />
                  );
                }),
              )}
            </div>
          )}
        </>
      ) : (
        <span className="page-placeholder">第 {number} 页</span>
      )}
      {error && <div className="page-error">{error}</div>}
      <span className="page-number">{number}</span>
    </div>
  );
}

function DocxPreview({
  units,
  active,
  current,
  paneId,
  scroller,
  autoLocate,
  navigation,
}: {
  units: PreviewUnit[];
  active: Unit | null;
  current: number;
  paneId: string;
  scroller: React.RefObject<HTMLDivElement | null>;
  autoLocate: boolean;
  navigation: number;
}) {
  useEffect(() => {
    if (active && autoLocate)
      scroller.current
        ?.querySelector(`[data-unit-id="${active.unit_id}"]`)
        ?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [active, current, units, autoLocate, scroller, navigation]);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < units.length; ) {
    const unit = units[i];
    const content = (value: PreviewUnit) => (
      <span
        id={`${paneId}-unit-${value.unit_id}`}
        data-unit-id={value.unit_id}
        data-unit-key={value.anchor.key}
        className={active?.unit_id === value.unit_id ? "docx-target" : ""}
      >
        <Highlight
          text={value.text || "\u00a0"}
          ranges={active?.unit_id === value.unit_id ? active.ranges : []}
          current={current}
        />
      </span>
    );
    if (unit.anchor.type === "cell") {
      const cells: PreviewUnit[] = [];
      const table = unit.anchor.table;
      while (i < units.length && units[i].anchor.table === table)
        cells.push(units[i++]);
      const rows = new Map<number, PreviewUnit[]>();
      cells.forEach((cell) => {
        const r = cell.anchor.row || 0;
        rows.set(r, [...(rows.get(r) || []), cell]);
      });
      parts.push(
        <table className="docx-table" key={unit.unit_id}>
          <tbody>
            {Array.from(rows).map(([row, rowCells]) => (
              <tr key={row}>
                {rowCells.map((cell) => (
                  <td
                    key={cell.unit_id}
                    colSpan={cell.anchor.colspan || 1}
                    title={cell.label}
                  >
                    {content(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
    } else {
      parts.push(
        unit.anchor.heading ? (
          <h2 key={unit.unit_id}>{content(unit)}</h2>
        ) : (
          <p key={unit.unit_id}>{content(unit)}</p>
        ),
      );
      i++;
    }
  }
  return <article className="docx-sheet">{parts}</article>;
}

export function Reader({
  selection,
  onClose,
  onError,
  onRebuild,
  paneId = "primary",
  onPosition,
  onBookmark,
  frozen = false,
}: {
  selection: Selection | null;
  onClose: () => void;
  onError: (message: string) => void;
  onRebuild: (id: string) => void;
  paneId?: string;
  onPosition?: (position: ReadingPosition) => void;
  onBookmark?: () => void;
  frozen?: boolean;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [units, setUnits] = useState<PreviewUnit[]>([]);
  const [active, setActive] = useState<Unit | null>(null);
  const [current, setCurrent] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [width, setWidth] = useState(600);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [find, setFind] = useState("");
  const [pageInput, setPageInput] = useState("1");
  const [followHit, setFollowHit] = useState(false);
  const pageEditor = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const doc = selection?.document;
  const callbacks = useRef({ onPosition });
  callbacks.current = { onPosition };
  const restoring = useRef(false);
  const lastPosition = useRef<ReadingPosition | undefined>(selection?.position);
  const layoutPosition = useRef<ReadingPosition | undefined>(undefined);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const positionSelection = useRef(selection);
  positionSelection.current = selection;
  const emit = () => {
    const element = scroller.current,
      selected = positionSelection.current;
    if (
      !element ||
      !selected ||
      restoring.current ||
      loading ||
      error ||
      !element.clientHeight ||
      !element.clientWidth
    )
      return;
    const rect = element.getBoundingClientRect();
    // scrollIntoView honors the reader's scroll-padding. A previous PDF page
    // can leave a thin tail above the requested page; that is not the page
    // being read. Keep offsets relative to the viewport for existing saves.
    const pageSelectionTop =
      selected.document.kind === "pdf"
        ? rect.top +
          element.clientTop +
          (Number.parseFloat(getComputedStyle(element).scrollPaddingTop) || 0)
        : rect.top;
    const children = Array.from(
      element.querySelectorAll<HTMLElement>(
        selected.document.kind === "pdf" ? "[data-page]" : "[data-unit-id]",
      ),
    );
    const child =
      children.find(
        (node) => node.getBoundingClientRect().bottom > pageSelectionTop + 1,
      ) ?? children.at(-1);
    if (!child) return;
    const bounds = child.getBoundingClientRect();
    const position: ReadingPosition = {
      document_id: selected.document.id,
      content_hash: selected.document.content_hash,
      page: child.dataset.page ? Number(child.dataset.page) : undefined,
      key: child.dataset.unitKey,
      unit_id:
        child.dataset.unitId ??
        (active?.anchor.page === Number(child.dataset.page)
          ? active?.unit_id
          : undefined),
      offset: Math.max(
        0,
        Math.min(1, (rect.top - bounds.top) / Math.max(1, bounds.height)),
      ),
      horizontal:
        element.scrollLeft /
        Math.max(1, element.scrollWidth - element.clientWidth),
      lexicon_version:
        selected.hit?.lexicon_version ?? selected.position?.lexicon_version,
      hit_unit_id: active?.unit_id,
      hit_page: active?.anchor.page,
      hit_key: active?.anchor.key,
      version: selected.document.version,
      zoom,
      rotation: rotation as ReadingPosition["rotation"],
      match: current,
      find,
    };
    if (position.page && document.activeElement !== pageEditor.current)
      setPageInput(String(position.page));
    lastPosition.current = position;
    callbacks.current.onPosition?.(position);
  };
  const emitRef = useRef(emit);
  emitRef.current = emit;

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const handle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => emitRef.current());
    };
    element.addEventListener("scroll", handle, { passive: true });
    return () => {
      element.removeEventListener("scroll", handle);
      cancelAnimationFrame(frame);
    };
  }, [!!doc]);
  useEffect(() => {
    emitRef.current();
  }, [zoom, rotation, find, current]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let measuredWidth = 0,
      wasHidden = false;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0].contentRect.width;
      if (!nextWidth || !entries[0].contentRect.height) {
        wasHidden = true;
        return;
      }
      if (
        measuredWidth &&
        (wasHidden || Math.abs(measuredWidth - nextWidth) > 2) &&
        lastPosition.current
      ) {
        layoutPosition.current = lastPosition.current;
        restoring.current = true;
        setFollowHit(false);
        setLayoutRevision((value) => value + 1);
      }
      wasHidden = false;
      measuredWidth = nextWidth;
      setWidth(Math.max(280, nextWidth - 72));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [!!doc]);

  useEffect(() => {
    setPdf(null);
    setUnits([]);
    setActive(null);
    setCurrent(0);
    setRotation(selection?.position?.rotation ?? 0);
    setZoom(selection?.position?.zoom ?? 1);
    setError("");
    setFind(selection?.position?.find ?? "");
    setPageInput(String(selection?.position?.page ?? 1));
    restoring.current = true;
    if (!doc) return;
    if (
      selection?.position?.content_hash &&
      selection.position.content_hash !== doc.content_hash
    ) {
      setLoading(false);
      setError("资料已替换，原位置待确认。请从资料列表重新打开。");
      return;
    }
    let cancelled = false;
    setLoading(true);
    const url = `/api/documents/${doc.id}/content?version=${doc.version}`;
    const task =
      doc.kind === "pdf"
        ? getDocument({
            url,
            cMapUrl: "/pdf-assets/cmaps/",
            cMapPacked: true,
            standardFontDataUrl: "/pdf-assets/standard_fonts/",
            wasmUrl: "/pdf-assets/wasm/",
            isEvalSupported: false,
          })
        : null;
    if (task) {
      task.promise
        .then((value) => {
          if (!cancelled) {
            setPdf(value);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setError(
              "无法打开 PDF。资料可能已更新或本地副本缺失，请重新打开或导入。",
            );
            setLoading(false);
          }
        });
    } else {
      api<{ units: PreviewUnit[] }>(
        `/documents/${doc.id}/content?version=${doc.version}`,
      )
        .then((value) => {
          if (!cancelled) {
            setUnits(value.units);
            setLoading(false);
          }
        })
        .catch((reason) => {
          if (!cancelled) {
            setError(reason.message);
            setLoading(false);
          }
        });
    }
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [doc?.id, doc?.version]);

  useEffect(() => {
    setActive(null);
    setFollowHit(!!selection?.hit);
    lastPosition.current = selection?.position;
    layoutPosition.current = undefined;
    setCurrent(selection?.position?.match ?? 0);
    setZoom(selection?.position?.zoom ?? 1);
    setRotation(selection?.position?.rotation ?? 0);
    setFind(selection?.position?.find ?? "");
    restoring.current = true;
    const unitId =
      selection?.hit?.unit_id ??
      selection?.position?.hit_unit_id ??
      selection?.position?.unit_id;
    if (!unitId || !doc) return;
    if (
      selection?.position?.version &&
      selection.position.version !== doc.version
    )
      return;
    setNavigation((value) => value + 1);
    let cancelled = false;
    const params = new URLSearchParams({
      mode: selection.mode || "all",
      version: String(doc.version),
      expand: String(selection?.expand ?? false),
    });
    const lexiconVersion =
      selection?.hit?.lexicon_version ?? selection?.position?.lexicon_version;
    if (lexiconVersion) params.set("lexicon_version", lexiconVersion);
    if (selection?.query) params.set("q", selection.query);
    if (selection?.course) params.set("course_id", selection.course);
    api<Unit>(`/documents/${doc.id}/units/${unitId}?${params}`)
      .then((value) => {
        if (!cancelled) {
          setActive(value);
          if (value.anchor.page) setPageInput(String(value.anchor.page));
        }
      })
      .catch((reason) => {
        if (!cancelled) onError(reason.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selection?.visitId, doc?.id, doc?.version]);

  useEffect(() => {
    if (!doc || loading || error || (!pdf && !units.length)) return;
    const saved = layoutPosition.current ?? selection?.position;
    const adjustingLayout = !!layoutPosition.current;
    let frame = 0,
      attempts = 0;
    const restore = () => {
      const element = scroller.current;
      if (!element || !element.clientHeight || !element.clientWidth) return;
      if (selection?.hit && !adjustingLayout) {
        // PdfPage/DocxPreview owns the initial search-hit jump.
        if (
          !active ||
          (doc.kind === "pdf" &&
            !element.querySelector(".pdf-highlight.active"))
        ) {
          if (++attempts < 240) {
            frame = requestAnimationFrame(restore);
            return;
          }
        }
        restoring.current = false;
        emitRef.current();
        return;
      }
      const selector =
        doc.kind === "pdf"
          ? `[data-page="${saved?.page ?? 1}"]`
          : saved?.unit_id
            ? `[data-unit-id="${saved.unit_id}"]`
            : "[data-unit-id]";
      const target = element.querySelector<HTMLElement>(selector);
      if (!target) {
        if (++attempts < 240) frame = requestAnimationFrame(restore);
        return;
      }
      const top =
        element.scrollTop +
        target.getBoundingClientRect().top -
        element.getBoundingClientRect().top;
      element.scrollTop =
        top + (saved?.offset ?? 0) * target.getBoundingClientRect().height;
      element.scrollLeft =
        (saved?.horizontal ?? 0) * (element.scrollWidth - element.clientWidth);
      if (
        doc.kind === "pdf" &&
        !target.querySelector(".textLayer span") &&
        ++attempts < 180
      ) {
        frame = requestAnimationFrame(restore);
        return;
      }
      layoutPosition.current = undefined;
      restoring.current = false;
      emitRef.current();
    };
    frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [
    selection?.visitId,
    doc?.id,
    pdf,
    units,
    active,
    loading,
    error,
    layoutRevision,
  ]);

  if (!doc)
    return (
      <section className="reader reader-empty">
        <div className="reader-topline">
          <span>原文阅读</span>
          <span className="subtle">与你的搜索并排</span>
        </div>
        <div className="reader-empty-content">
          <div className="paper-art">
            <div className="art-rule short" />
            <div className="art-rule" />
            <div className="art-rule" />
            <div className="art-highlight" />
            <div className="art-rule" />
            <div className="art-rule medium" />
            <span>
              <Icon name="search" size={24} />
            </span>
          </div>
          <h2>找到之后，回到原文</h2>
          <p>
            点击搜索结果，在这里阅读完整上下文。
            <br />
            PDF 定位到页，DOCX 定位到段落。
          </p>
          <div className="local-promise">
            <Icon name="lock" size={14} /> 资料始终保存在这台电脑
          </div>
        </div>
      </section>
    );

  const jumpToPage = () => {
    setFollowHit(false);
    const page = Math.max(
      1,
      Math.min(pdf?.numPages || 1, Number.parseInt(pageInput) || 1),
    );
    setPageInput(String(page));
    scroller.current
      ?.querySelector(`[data-page="${page}"]`)
      ?.scrollIntoView({ block: "start", behavior: "instant" });
  };
  const noCoordinates =
    active &&
    doc.kind === "pdf" &&
    !active.rectangles?.some((rects) => rects.length);
  const changeMatch = (step: number) => {
    if (!active?.ranges.length) return;
    setFollowHit(true);
    setNavigation((value) => value + 1);
    setCurrent(
      (value) => (value + step + active.ranges.length) % active.ranges.length,
    );
  };

  return (
    <section className="reader" data-reader={paneId}>
      <div className="reader-title">
        <span className={`file-label ${doc.kind}`}>
          {doc.kind.toUpperCase()}
        </span>
        <div>
          <strong title={doc.name}>{doc.name}</strong>
          <span>
            {doc.course_name} <span className="dot">·</span>{" "}
            {doc.kind === "pdf"
              ? `${doc.unit_count} 页`
              : `${doc.unit_count} 个文本单元`}
          </span>
        </div>
        <button
          className="icon-button"
          disabled={frozen}
          title="重新建立此文件索引"
          onClick={() => onRebuild(doc.id)}
        >
          <Icon name="refresh" size={16} />
        </button>
        <button
          className="icon-button"
          title="收藏当前位置"
          onClick={() => {
            emitRef.current();
            onBookmark?.();
          }}
        >
          <Icon name="bookmark" size={17} />
        </button>
        <button className="icon-button" title="关闭阅读" onClick={onClose}>
          <Icon name="close" size={17} />
        </button>
      </div>
      <div className="reader-toolbar">
        {doc.kind === "pdf" ? (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                jumpToPage();
              }}
            >
              <input
                ref={pageEditor}
                aria-label="跳转页码"
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
              />
              <span>/ {pdf?.numPages || doc.unit_count}</span>
            </form>
            <span className="toolbar-divider" />
            <button
              className="icon-button"
              title="缩小"
              onClick={() => setZoom((value) => Math.max(0.5, value - 0.15))}
            >
              <Icon name="minus" size={15} />
            </button>
            <button
              className="zoom-button"
              title="恢复适合宽度"
              onClick={() => setZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              className="icon-button"
              title="放大"
              onClick={() => setZoom((value) => Math.min(3, value + 0.15))}
            >
              <Icon name="plus" size={15} />
            </button>
            <button
              className="icon-button"
              title="顺时针旋转"
              onClick={() => setRotation((value) => (value + 90) % 360)}
            >
              <Icon name="rotate" size={16} />
            </button>
          </>
        ) : (
          <span className="subtle">结构化文本预览 · 按段落定位</span>
        )}
        {active && (
          <div className="match-controls">
            <button
              className="icon-button"
              title="上一个命中"
              disabled={!active.ranges.length}
              onClick={() => changeMatch(-1)}
            >
              <Icon name="left" size={14} />
            </button>
            <span>
              {active.ranges.length ? current + 1 : 0} / {active.ranges.length}
            </span>
            <button
              className="icon-button"
              title="下一个命中"
              disabled={!active.ranges.length}
              onClick={() => changeMatch(1)}
            >
              <Icon name="arrow" size={14} />
            </button>
          </div>
        )}
      </div>
      {doc.kind === "docx" && (
        <div className="reader-notice">
          <Icon name="info" size={14} />
          <span>
            段落与表格预览，无 Word
            页码；图片、文本框、页眉页脚与批注不参与检索。
          </span>
        </div>
      )}
      {doc.kind === "pdf" && (
        <div className="page-find">
          <Icon name="search" size={14} />
          <input
            aria-label="页内查找"
            placeholder="页内查找（高亮匹配的文字片段）"
            value={find}
            onChange={(event) => setFind(event.target.value)}
          />
          {find && (
            <button
              className="icon-button"
              title="清空页内查找"
              onClick={() => setFind("")}
            >
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
      )}
      {noCoordinates && (
        <div className="reader-notice warning">
          已跳到正确页，精确高亮不可用，请使用页内查找。
        </div>
      )}
      <div
        className="reader-scroll"
        ref={scroller}
        onWheel={() => setFollowHit(false)}
        onPointerDown={() => setFollowHit(false)}
      >
        {loading && (
          <div className="reader-loading">
            <span className="spinner" /> 正在加载原文…
          </div>
        )}
        {error && (
          <div className="reader-error">
            <Icon name="info" />
            <p>{error}</p>
          </div>
        )}
        {pdf &&
          Array.from({ length: pdf.numPages }, (_, index) => (
            <PdfPage
              key={`${doc.id}-${index}`}
              pdf={pdf}
              number={index + 1}
              width={width}
              zoom={zoom}
              rotation={rotation}
              active={active}
              current={current}
              navigation={navigation}
              find={find}
              scroller={scroller}
              autoLocate={followHit}
              onLocated={(number) => {
                if (document.activeElement !== pageEditor.current)
                  setPageInput(String(number));
              }}
            />
          ))}
        {!loading && !error && doc.kind === "docx" && (
          <DocxPreview
            units={units}
            active={active}
            current={current}
            paneId={paneId}
            scroller={scroller}
            autoLocate={followHit}
            navigation={navigation}
          />
        )}
      </div>
      <div className="reader-footer">
        <span>
          <span className="status-dot" /> 本地原文
        </span>
        <span>
          {active?.label ||
            (doc.kind === "pdf" ? "文字型页面可检索" : "无原生页码")}{" "}
          · v{doc.version}
        </span>
      </div>
    </section>
  );
}
