import type { Range } from "./types";

export function Highlight({
  text,
  ranges,
  current = -1,
}: {
  text: string;
  ranges: Range[];
  current?: number;
}) {
  // API offsets are Unicode code points, not UTF-16 code units (emoji-safe).
  const chars = Array.from(text);
  const merged: { start: number; end: number; current: boolean }[] = [];
  ranges.forEach(([start, end], index) => {
    const last = merged.at(-1);
    if (last && start < last.end) {
      last.end = Math.max(last.end, end);
      last.current ||= index === current;
    } else merged.push({ start, end, current: index === current });
  });
  let previous = 0;
  const pieces: React.ReactNode[] = [];
  merged.forEach(({ start, end, current: active }, index) => {
    pieces.push(chars.slice(previous, start).join(""));
    pieces.push(
      <mark className={active ? "current-mark" : ""} key={index}>
        {chars.slice(start, end).join("")}
      </mark>,
    );
    previous = end;
  });
  pieces.push(chars.slice(previous).join(""));
  return <>{pieces}</>;
}
