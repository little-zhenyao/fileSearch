"""Finite, inspectable local query expansion; no stemming guesses or network resources."""
from __future__ import annotations

import json
from dataclasses import dataclass

from .text import Query, is_cjk, occurrences

DEFAULT_GROUPS = [
    ('form', ['deadlock', 'deadlocks']), ('form', ['process', 'processes']),
    ('form', ['thread', 'threads']), ('form', ['resource', 'resources']),
    ('form', ['semaphore', 'semaphores']), ('form', ['mutex', 'mutexes']),
    ('form', ['lock', 'locks', 'locking', 'locked']),
    ('form', ['schedule', 'schedules', 'scheduling', 'scheduled']),
    ('form', ['algorithm', 'algorithms']), ('form', ['memory', 'memories']),
    ('synonym', ['starvation', 'indefinite blocking']),
]


@dataclass
class SearchPlan:
    original: Query
    paths: list[tuple[str, list[list[dict]]]]
    expansions: list[dict]

    @classmethod
    def create(cls, q, mode, vocabulary=()):
        original = Query.parse(q, mode)
        groups = [(row['kind'], json.loads(row['terms'])) for row in vocabulary]
        expansions = []

        def variants(term, allow_forms=True):
            result = [{'term': term, 'source': 'original'}]
            for kind, entries in groups:
                if (kind == 'form' and not allow_forms) or term not in entries:
                    continue
                for entry in entries:
                    if not any(item['term'] == entry for item in result):
                        item = {'term': entry, 'source': kind}
                        result.append(item)
                        if entry != term and item not in expansions:
                            expansions.append(item)
            if len(result) > 64:
                raise ValueError('扩展词过多，请缩小词表组。')
            return result

        if mode == 'phrase':
            paths = [('all', [variants(original.text, False)])]
        else:
            paths = [(mode, [variants(token) for token in original.tokens])]
            # A registered phrase can also occupy one group in a longer query. Keep
            # token offsets (and repeated tokens) so overlapping phrases describe
            # alternative, non-overlapping ways to cover the original query.
            tokens = []
            start = None
            for index, char in enumerate(original.text + ' '):
                if start is not None and (not char.isalnum() or is_cjk(char) != is_cjk(original.text[start])):
                    tokens.append((original.text[start:index], start, index))
                    start = None
                if char.isalnum() and start is None:
                    start = index
            starts = {start: index for index, (_, start, _) in enumerate(tokens)}
            ends = {end: index + 1 for index, (_, _, end) in enumerate(tokens)}
            phrases = {}
            for kind, entries in groups:
                if kind != 'synonym':
                    continue
                for term in entries:
                    for start, end in occurrences(original.text, term):
                        left, right = starts.get(start), ends.get(end)
                        if left is None or right is None or right - left < 2:
                            continue
                        key = (left, right, term)
                        if key not in phrases:
                            phrases[key] = variants(term, False)[1:]

            if mode == 'any':
                for replacements in phrases.values():
                    paths.append(('any', [replacements]))
            elif phrases:
                choices = {}
                for (left, right, _), replacements in phrases.items():
                    choices.setdefault(left, []).append((right, replacements))

                def cover(index, selected, replaced):
                    if index == len(tokens):
                        if replaced and ('all', selected) not in paths:
                            alternatives = sum(len(group) for _, path in paths for group in path)
                            if len(paths) >= 128 or alternatives + sum(map(len, selected)) > 30_000:
                                raise ValueError('重叠短语扩展组合过多，请缩小词表组。')
                            paths.append(('all', selected))
                        return
                    cover(index + 1, [*selected, variants(tokens[index][0])], replaced)
                    for right, replacements in choices.get(index, []):
                        cover(right, [*selected, replacements], True)

                cover(0, [], False)

            # Retain explicit whole-query replacements, including punctuation.
            if len(original.tokens) > 1:
                for item in variants(original.text, False)[1:]:
                    if ('all', [[item]]) not in paths:
                        paths.append(('all', [[item]]))
        return cls(original, paths, expansions)

    def candidates(self):
        """SQL is a superset of final matches; short Chinese terms need a text scan."""
        path_sql, values = [], []
        for mode, groups in self.paths:
            parts = []
            for variants in groups:
                choices = []
                for item in variants:
                    term = item['term']
                    if any(is_cjk(char) for char in term):
                        if len(term) < 3:
                            choices.append('1')
                            continue
                        table = 'units_tri'
                    else:
                        table = 'units_fts'
                    choices.append(f'u.rowid IN (SELECT rowid FROM {table} WHERE {table} MATCH ?)')
                    values.append('"' + term.replace('"', '""') + '"')
                parts.append('(' + ' OR '.join(choices) + ')')
            path_sql.append('(' + (' OR ' if mode == 'any' else ' AND ').join(parts) + ')')
        return '(' + ' OR '.join(path_sql) + ')', values

    def matches(self, text, mapping):
        details = {}
        for mode, groups in self.paths:
            matched = []
            for variants in groups:
                group_hits = []
                for item in variants:
                    ranges = Query.parse(item['term'], 'phrase').matches(text, mapping)
                    group_hits.extend((tuple(span), item) for span in ranges)
                matched.append(group_hits)
            if mode != 'any' and not all(matched):
                continue
            for group in matched:
                for span, item in group:
                    previous = details.get(span)
                    if previous is None or item['source'] == 'original':
                        details[span] = {**item, 'range': list(span)}
        ordered = [details[key] for key in sorted(details)]
        return [item['range'] for item in ordered], ordered
