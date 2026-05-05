/**
 * Pure module for searching the visible text of Word OOXML parts.
 *
 * Word splits runs (`<w:r>`) at arbitrary points, so a phrase the user sees
 * in Word may be split across multiple `<w:t>` elements in document.xml.
 * This module concatenates the decoded text of `<w:t>` (and optionally
 * `<w:delText>`) elements into a single searchable string per part, while
 * tracking the source `(line, column)` of every decoded character so that
 * matches can be mapped back to a precise editor range.
 *
 * No vscode imports — this module is unit-testable in isolation.
 */

export type SearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  includeDeletions: boolean;
};

export type Segment = {
  startInConcat: number;
  length: number;
  isDeletion: boolean;
  // (line, column) of the FIRST decoded character. Captured lazily after any
  // leading CDATA delimiter so position math is correct even when a segment
  // begins with `<![CDATA[`.
  startLine: number;
  startColumn: number;
  // sourceAdvance[i] = number of source characters consumed between the start
  // of decoded character i and the start of decoded character i+1 (or the
  // end of the segment if i is the last decoded character). Skipped delimiter
  // chunks (e.g. `<![CDATA[` and `]]>`) are folded into the entry of the
  // PRECEDING decoded character, so positionAt(seg, k) = startLine/Column +
  // sum(sourceAdvance[0..k-1]).
  // For decoded characters that occupy two JS UTF-16 code units (i.e. astral
  // characters from numeric entities like `&#x1F600;`), the high surrogate
  // carries the full source span and the low surrogate gets a 0 entry; this
  // preserves `length === sourceAdvance.length`.
  sourceAdvance: number[];
  // Verbatim source text starting at the first decoded character. Used to
  // walk newline boundaries when computing line/column for a match.
  sourceText: string;
};

export type WalkResult = {
  concatenated: string;
  segments: Segment[];
};

export type Match = {
  partPath: string;
  cacheFilePath: string;
  matchLine: number;
  matchColumn: number;
  matchEndLine: number;
  matchEndColumn: number;
  // Decoded text around the match (with leading/trailing ellipsis if
  // truncated). Visual highlighting is the consumer's responsibility — the
  // matched span is given by `snippetMatchStart` (inclusive) and
  // `snippetMatchEnd` (exclusive) so the snippet stays unambiguous when the
  // surrounding text contains literal `[` or `]` characters.
  snippet: string;
  snippetMatchStart: number;
  snippetMatchEnd: number;
};

export type PartInput = {
  partPath: string;
  cacheFilePath: string;
  xml: string;
};

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeEntity(entity: string): string | null {
  const named = NAMED_ENTITIES[entity];
  if (named !== undefined) {
    return named;
  }
  if (entity.length > 3 && entity.startsWith('&#') && entity.endsWith(';')) {
    const body = entity.slice(2, -1);
    let code: number;
    if (body[0] === 'x' || body[0] === 'X') {
      code = parseInt(body.slice(1), 16);
    } else {
      code = parseInt(body, 10);
    }
    if (Number.isFinite(code) && code >= 0) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseTagName(tagBody: string): string {
  let end = 0;
  while (end < tagBody.length) {
    const c = tagBody.charCodeAt(end);
    // whitespace or '/'
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x2f) {
      break;
    }
    end++;
  }
  return tagBody.slice(0, end);
}

/**
 * Walks the formatted XML of a part and produces:
 *   - `concatenated`: the searchable string (decoded text of all `<w:t>`
 *     elements, plus `<w:delText>` if `includeDeletions`, joined with `\n`
 *     at every paragraph end / break / tab).
 *   - `segments`: descriptors that map every decoded character back to its
 *     `(line, column)` in the source XML.
 */
export function walk(xml: string, includeDeletions: boolean): WalkResult {
  let i = 0;
  let line = 1;
  let column = 1;
  const concatPieces: string[] = [];
  let concatLen = 0;
  const segments: Segment[] = [];

  const advance = (n: number): void => {
    const target = i + n;
    while (i < target && i < xml.length) {
      if (xml.charCodeAt(i) === 0x0a) {
        line++;
        column = 1;
      } else {
        column++;
      }
      i++;
    }
  };

  const skipToEndOf = (marker: string): void => {
    const idx = xml.indexOf(marker, i);
    if (idx < 0) {
      advance(xml.length - i);
    } else {
      advance(idx + marker.length - i);
    }
  };

  while (i < xml.length) {
    if (xml.charCodeAt(i) !== 0x3c /* '<' */) {
      advance(1);
      continue;
    }

    if (xml.startsWith('<![CDATA[', i)) {
      // CDATA outside of a w:t/w:delText body — content is invisible to readers
      advance(9);
      skipToEndOf(']]>');
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      advance(4);
      skipToEndOf('-->');
      continue;
    }
    if (xml.startsWith('<?', i)) {
      advance(2);
      skipToEndOf('?>');
      continue;
    }
    if (xml.startsWith('</', i)) {
      const end = xml.indexOf('>', i);
      if (end < 0) {
        advance(xml.length - i);
        break;
      }
      const name = xml.slice(i + 2, end).trim();
      if (name === 'w:p') {
        concatPieces.push('\n');
        concatLen++;
      }
      advance(end + 1 - i);
      continue;
    }

    const tagEnd = xml.indexOf('>', i);
    if (tagEnd < 0) {
      advance(xml.length - i);
      break;
    }
    const tagBody = xml.slice(i + 1, tagEnd);
    const isSelfClosing = tagBody.endsWith('/');
    const name = parseTagName(tagBody);

    if (name === 'w:br' || name === 'w:tab') {
      concatPieces.push('\n');
      concatLen++;
      advance(tagEnd + 1 - i);
      continue;
    }

    if (name === 'w:instrText') {
      advance(tagEnd + 1 - i);
      if (!isSelfClosing) {
        skipToEndOf('</w:instrText>');
      }
      continue;
    }

    const isWt = name === 'w:t';
    const isDel = name === 'w:delText';
    if (!isWt && !isDel) {
      advance(tagEnd + 1 - i);
      continue;
    }

    if (isDel && !includeDeletions) {
      advance(tagEnd + 1 - i);
      if (!isSelfClosing) {
        skipToEndOf('</w:delText>');
      }
      continue;
    }

    if (isSelfClosing) {
      advance(tagEnd + 1 - i);
      continue;
    }

    advance(tagEnd + 1 - i);

    let decoded = '';
    const sourceAdvance: number[] = [];
    let segStartLine = -1;
    let segStartColumn = -1;
    let sourceTextStart = -1;
    let pendingSkip = 0;
    const closeTag = isDel ? '</w:delText>' : '</w:t>';

    const recordDecoded = (decodedChars: string, ownSpan: number): void => {
      if (segStartLine === -1) {
        segStartLine = line;
        segStartColumn = column;
        sourceTextStart = i;
        pendingSkip = 0; // discard any skip preceding the first decoded char
      } else if (pendingSkip > 0) {
        // Fold preceding skipped delimiter chars into the previous entry.
        sourceAdvance[sourceAdvance.length - 1] += pendingSkip;
        pendingSkip = 0;
      }
      decoded += decodedChars;
      sourceAdvance.push(ownSpan);
      // Surrogate pair (or wider grapheme): only the first JS code unit
      // carries the source span; subsequent units get 0 so the
      // `decoded.length === sourceAdvance.length` invariant holds.
      for (let k = 1; k < decodedChars.length; k++) {
        sourceAdvance.push(0);
      }
    };

    while (i < xml.length) {
      if (xml.startsWith(closeTag, i)) {
        break;
      }
      if (xml.startsWith('<![CDATA[', i)) {
        advance(9);
        pendingSkip += 9;
        const cdataEnd = xml.indexOf(']]>', i);
        if (cdataEnd < 0) {
          advance(xml.length - i);
          break;
        }
        while (i < cdataEnd) {
          recordDecoded(xml[i], 1);
          advance(1);
        }
        advance(3);
        pendingSkip += 3;
        continue;
      }
      const code = xml.charCodeAt(i);
      if (code === 0x26 /* '&' */) {
        const semi = xml.indexOf(';', i + 1);
        if (semi > i && semi - i <= 12) {
          const entity = xml.slice(i, semi + 1);
          const decodedChar = decodeEntity(entity);
          if (decodedChar !== null) {
            recordDecoded(decodedChar, entity.length);
            advance(entity.length);
            continue;
          }
        }
        recordDecoded(xml[i], 1);
        advance(1);
        continue;
      }
      if (code === 0x3c /* '<' */) {
        // unexpected open inside text — bail out of this segment
        break;
      }
      recordDecoded(xml[i], 1);
      advance(1);
    }

    if (xml.startsWith(closeTag, i)) {
      advance(closeTag.length);
    }

    if (decoded.length > 0 && sourceTextStart !== -1) {
      // sourceText covers from the first decoded char's source position to
      // wherever we stopped reading. It may include trailing skipped chars
      // (e.g. a `]]>` immediately before `</w:t>`); positionAt only walks
      // through the entries in sourceAdvance, so trailing junk is harmless.
      const sourceText = xml.slice(sourceTextStart, i);
      segments.push({
        startInConcat: concatLen,
        length: decoded.length,
        isDeletion: isDel,
        startLine: segStartLine,
        startColumn: segStartColumn,
        sourceAdvance,
        sourceText,
      });
      concatPieces.push(decoded);
      concatLen += decoded.length;
    }
  }

  return { concatenated: concatPieces.join(''), segments };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSegment(segments: Segment[], offset: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (offset < seg.startInConcat) {
      hi = mid - 1;
    } else if (offset >= seg.startInConcat + seg.length) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

/**
 * Returns the source (line, column) of the position immediately preceding
 * decoded character `decodedOffset` within the segment. If `decodedOffset`
 * equals `segment.length`, this returns the position immediately AFTER the
 * last decoded character — i.e. the end position of the segment's text.
 */
function positionAt(seg: Segment, decodedOffset: number): { line: number; column: number } {
  let line = seg.startLine;
  let column = seg.startColumn;
  let srcIdx = 0;
  const limit = Math.min(decodedOffset, seg.sourceAdvance.length);
  for (let k = 0; k < limit; k++) {
    const span = seg.sourceAdvance[k];
    for (let s = 0; s < span; s++) {
      if (seg.sourceText.charCodeAt(srcIdx) === 0x0a) {
        line++;
        column = 1;
      } else {
        column++;
      }
      srcIdx++;
    }
  }
  return { line, column };
}

const SNIPPET_WINDOW = 40;

type SnippetView = {
  text: string;
  matchStart: number;
  matchEnd: number;
};

function buildSnippet(concat: string, start: number, end: number): SnippetView {
  const ws = Math.max(0, start - SNIPPET_WINDOW);
  const we = Math.min(concat.length, end + SNIPPET_WINDOW);
  const before = concat.slice(ws, start).replace(/\n/g, ' ');
  const matched = concat.slice(start, end);
  const after = concat.slice(end, we).replace(/\n/g, ' ');
  const leadingEllipsis = ws > 0 ? '…' : '';
  const trailingEllipsis = we < concat.length ? '…' : '';
  const text = leadingEllipsis + before + matched + after + trailingEllipsis;
  const matchStart = leadingEllipsis.length + before.length;
  return { text, matchStart, matchEnd: matchStart + matched.length };
}

export function searchDocumentText(parts: PartInput[], term: string, options: SearchOptions): Match[] {
  if (term.trim() === '') {
    return [];
  }
  const escaped = escapeRegex(term);
  const body = options.wholeWord ? `\\b${escaped}\\b` : escaped;
  const flags = options.caseSensitive ? 'g' : 'gi';
  const re = new RegExp(body, flags);

  const matches: Match[] = [];
  for (const part of parts) {
    const { concatenated, segments } = walk(part.xml, options.includeDeletions);
    if (segments.length === 0) {
      continue;
    }
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(concatenated)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const startIdx = m.index;
      const endIdx = m.index + m[0].length;
      const startSegIdx = findSegment(segments, startIdx);
      const endSegIdx = findSegment(segments, endIdx - 1);
      if (startSegIdx < 0 || endSegIdx < 0) {
        continue;
      }
      const startSeg = segments[startSegIdx];
      const endSeg = segments[endSegIdx];
      const startPos = positionAt(startSeg, startIdx - startSeg.startInConcat);
      const endPos = positionAt(endSeg, endIdx - endSeg.startInConcat);
      const snippet = buildSnippet(concatenated, startIdx, endIdx);
      matches.push({
        partPath: part.partPath,
        cacheFilePath: part.cacheFilePath,
        matchLine: startPos.line,
        matchColumn: startPos.column,
        matchEndLine: endPos.line,
        matchEndColumn: endPos.column,
        snippet: snippet.text,
        snippetMatchStart: snippet.matchStart,
        snippetMatchEnd: snippet.matchEnd,
      });
    }
  }
  return matches;
}
