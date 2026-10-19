"""Search normalization with a map back to Unicode code-point offsets."""
from __future__ import annotations

import re
import unicodedata
from bisect import bisect_right
from dataclasses import dataclass


def is_cjk(char: str) -> bool:
    return any(lo <= ord(char) <= hi for lo, hi in (
        (0x3400, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x323AF),
    ))


def normalize(text: str) -> tuple[str, list[list[int]]]:
    """Retain source spans even when ligatures expand or whitespace contracts."""
    removed: set[int] = set()
    for match in re.finditer(r"(?<=[A-Za-z])-\s*\n\s*(?=[a-z])", text):
        removed.update(range(match.start(), match.end()))
    chars: list[str] = []
    mapping: list[list[int]] = []
    i = 0
    while i < len(text):
        start = i
        i += 1
        while i < len(text) and unicodedata.combining(text[i]):
            i += 1
        if start in removed or text[start] == '\u00ad':
            continue
        for char in unicodedata.normalize('NFKC', text[start:i]).casefold():
            if char.isspace():
                if chars and chars[-1] == ' ':
                    mapping[-1][1] = i
                    continue
                char = ' '
            chars.append(char)
            mapping.append([start, i])
    return ''.join(chars), mapping


def terms(text: str) -> list[str]:
    result: list[str] = []
    current = ''
    cjk = False
    for char in text:
        if not char.isalnum():
            if current:
                result.append(current)
            current = ''
            continue
        kind = is_cjk(char)
        if current and kind != cjk:
            result.append(current)
            current = ''
        current += char
        cjk = kind
    if current:
        result.append(current)
    return list(dict.fromkeys(result))


def word_char(char: str) -> bool:
    return char.isalnum() and not is_cjk(char)


def compact_mapping(mapping: list[list[int]]) -> dict:
    """Run-length encode mostly identity mappings; avoid loading thousands of pairs per hit."""
    runs: list[list[int]] = []
    for index, (start, end) in enumerate(mapping):
        last = runs[-1] if runs else None
        if last and last[1] - last[0] == last[3] - last[2] and end == start + 1 and last[3] == start:
            last[1] = index + 1
            last[3] = end
        elif last and last[2] == start and last[3] == end:
            last[1] = index + 1
        else:
            runs.append([index, index + 1, start, end])
    return {'runs': runs}


def occurrences(text: str, needle: str) -> list[tuple[int, int]]:
    hits = []
    offset = 0
    while needle and (start := text.find(needle, offset)) != -1:
        end = start + len(needle)
        left = word_char(needle[0]) and start > 0 and word_char(text[start - 1])
        right = word_char(needle[-1]) and end < len(text) and word_char(text[end])
        if not left and not right:
            hits.append((start, end))
        offset = start + 1
    return hits


@dataclass(frozen=True)
class Query:
    text: str
    mode: str
    tokens: list[str]

    @classmethod
    def parse(cls, text: str, mode: str) -> 'Query':
        if mode not in ('all', 'any', 'phrase'):
            raise ValueError('未知搜索模式')
        normalized = normalize(text.strip())[0].strip()
        tokens = terms(normalized)
        if not tokens:
            raise ValueError('请输入文字或数字')
        return cls(normalized, mode, tokens)

    def matches(self, text: str, mapping: list[list[int]] | dict) -> list[list[int]]:
        needles = [self.text] if self.mode == 'phrase' else self.tokens
        groups = [occurrences(text, term) for term in needles]
        if self.mode != 'any' and not all(groups):
            return []
        if isinstance(mapping, dict):
            runs = mapping['runs']
            starts = [run[0] for run in runs]

            def source(index):
                a, b, start, end = runs[bisect_right(starts, index) - 1]
                return (start + index - a, start + index - a + 1) if b - a == end - start else (start, end)
        else:
            def source(index):
                return mapping[index]
        return [list(span) for span in sorted({
            (source(start)[0], source(end - 1)[1])
            for group in groups for start, end in group
        })]


def snippet(text: str, ranges: list[list[int]], context: int = 65) -> dict:
    start = max(0, ranges[0][0] - context)
    end = min(len(text), ranges[0][1] + context)
    return {
        'text': text[start:end], 'prefix': start > 0, 'suffix': end < len(text),
        'ranges': [[max(a, start) - start, min(b, end) - start]
                   for a, b in ranges if a < end and b > start],
    }
