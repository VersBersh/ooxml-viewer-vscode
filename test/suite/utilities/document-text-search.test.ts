import { expect } from 'chai';
import { Match, PartInput, searchDocumentText, SearchOptions, walk } from '../../../src/utilities/document-text-search';

const defaultOptions: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  includeDeletions: false,
};

function part(xml: string, partPath = 'word/document.xml'): PartInput {
  return { partPath, cacheFilePath: `cache/${partPath}`, xml };
}

function search(xml: string, term: string, optionsOverride: Partial<SearchOptions> = {}): Match[] {
  return searchDocumentText([part(xml)], term, { ...defaultOptions, ...optionsOverride });
}

suite('document-text-search.walk', function () {
  test('single w:t produces a single segment with decoded text', function () {
    const xml = '<w:p><w:r><w:t>hello world</w:t></w:r></w:p>';
    const { concatenated, segments } = walk(xml, false);
    // concat is "hello world\n" (paragraph close adds newline)
    expect(concatenated).to.equal('hello world\n');
    expect(segments.length).to.equal(1);
    expect(segments[0].length).to.equal(11);
    expect(segments[0].isDeletion).to.be.false;
  });

  test('cross-run text is concatenated without separator', function () {
    const xml = '<w:p><w:r><w:t>the quick </w:t></w:r><w:r><w:t>brown fox</w:t></w:r></w:p>';
    const { concatenated, segments } = walk(xml, false);
    expect(concatenated).to.equal('the quick brown fox\n');
    expect(segments.length).to.equal(2);
    expect(segments[0].startInConcat).to.equal(0);
    expect(segments[1].startInConcat).to.equal(10);
  });

  test('paragraph close inserts a newline in concat', function () {
    const xml = '<w:p><w:r><w:t>foo</w:t></w:r></w:p><w:p><w:r><w:t>bar</w:t></w:r></w:p>';
    const { concatenated } = walk(xml, false);
    expect(concatenated).to.equal('foo\nbar\n');
  });

  test('xml:space=preserve whitespace is kept', function () {
    const xml = '<w:p><w:r><w:t xml:space="preserve">  hello  </w:t></w:r></w:p>';
    const { concatenated } = walk(xml, false);
    expect(concatenated).to.equal('  hello  \n');
  });

  test('entities are decoded', function () {
    const xml = '<w:p><w:r><w:t>AT&amp;T &lt;tag&gt; &#65;</w:t></w:r></w:p>';
    const { concatenated, segments } = walk(xml, false);
    expect(concatenated).to.equal('AT&T <tag> A\n');
    const seg = segments[0];
    // sourceAdvance for '&' is 5 ('&amp;'), for '<' is 4 ('&lt;'), '>' is 4, 'A' from &#65; is 4
    const advanceMap: Record<string, number> = {};
    let decodedIdx = 0;
    for (const ch of 'AT&T <tag> A') {
      advanceMap[ch + decodedIdx] = seg.sourceAdvance[decodedIdx];
      decodedIdx++;
    }
    // Index 2 is '&' from &amp; → 5
    expect(seg.sourceAdvance[2]).to.equal(5);
    // Index 5 is '<' from &lt; → 4
    expect(seg.sourceAdvance[5]).to.equal(4);
    // Index 9 is '>' from &gt; → 4
    expect(seg.sourceAdvance[9]).to.equal(4);
    // Index 11 is 'A' from &#65; → 5
    expect(seg.sourceAdvance[11]).to.equal(5);
  });

  test('CDATA inside w:t is treated as literal text', function () {
    const xml = '<w:p><w:r><w:t><![CDATA[ <w:t> not a tag </w:t> ]]></w:t></w:r></w:p>';
    const { concatenated } = walk(xml, false);
    expect(concatenated).to.equal(' <w:t> not a tag </w:t> \n');
  });

  test('w:instrText contents are skipped', function () {
    const xml = '<w:p><w:r><w:t>before </w:t></w:r><w:r><w:instrText>FIELDCODE</w:instrText></w:r><w:r><w:t> after</w:t></w:r></w:p>';
    const { concatenated } = walk(xml, false);
    expect(concatenated).to.equal('before  after\n');
  });

  test('w:delText excluded by default', function () {
    const xml = '<w:p><w:r><w:t>kept </w:t></w:r><w:r><w:delText>deleted </w:delText></w:r><w:r><w:t>tail</w:t></w:r></w:p>';
    const { concatenated, segments } = walk(xml, false);
    expect(concatenated).to.equal('kept tail\n');
    expect(segments.length).to.equal(2);
    expect(segments.every(s => !s.isDeletion)).to.be.true;
  });

  test('w:delText included when includeDeletions is true', function () {
    const xml = '<w:p><w:r><w:t>kept </w:t></w:r><w:r><w:delText>deleted </w:delText></w:r><w:r><w:t>tail</w:t></w:r></w:p>';
    const { concatenated, segments } = walk(xml, true);
    expect(concatenated).to.equal('kept deleted tail\n');
    expect(segments.length).to.equal(3);
    expect(segments[1].isDeletion).to.be.true;
  });

  test('w:br inserts a newline that blocks cross-break matches', function () {
    const xml = '<w:p><w:r><w:t>foo</w:t><w:br/><w:t>bar</w:t></w:r></w:p>';
    const { concatenated } = walk(xml, false);
    expect(concatenated).to.equal('foo\nbar\n');
  });

  test('comments and processing instructions are skipped', function () {
    const xml = '<?xml version="1.0"?><!-- preamble --><w:p><w:r><w:t>x</w:t></w:r></w:p>';
    const { concatenated, segments } = walk(xml, false);
    expect(concatenated).to.equal('x\n');
    expect(segments.length).to.equal(1);
  });
});

suite('document-text-search.searchDocumentText', function () {
  test('finds simple match in a single w:t', function () {
    const xml = '<w:p><w:r><w:t>hello world</w:t></w:r></w:p>';
    const matches = search(xml, 'world');
    expect(matches.length).to.equal(1);
    expect(matches[0].matchLine).to.equal(1);
  });

  test('finds cross-run match', function () {
    const xml = '<w:p><w:r><w:t>the quick </w:t></w:r><w:r><w:t>brown fox</w:t></w:r></w:p>';
    const matches = search(xml, 'quick brown');
    expect(matches.length).to.equal(1);
  });

  test('does not match across paragraph boundary', function () {
    const xml = '<w:p><w:r><w:t>foo</w:t></w:r></w:p><w:p><w:r><w:t>bar</w:t></w:r></w:p>';
    const matches = search(xml, 'foobar');
    expect(matches.length).to.equal(0);
  });

  test('does not match across w:br', function () {
    const xml = '<w:p><w:r><w:t>foo</w:t><w:br/><w:t>bar</w:t></w:r></w:p>';
    const matches = search(xml, 'foobar');
    expect(matches.length).to.equal(0);
  });

  test('whole word: matches "fox" but not "foxglove" or "redfox"', function () {
    const xml = '<w:p><w:r><w:t>the fox jumps over foxglove and redfox</w:t></w:r></w:p>';
    const matches = search(xml, 'fox', { wholeWord: true });
    expect(matches.length).to.equal(1);
  });

  test('case insensitive (default)', function () {
    const xml = '<w:p><w:r><w:t>The Fox</w:t></w:r></w:p>';
    const matches = search(xml, 'fox');
    expect(matches.length).to.equal(1);
  });

  test('case sensitive', function () {
    const xml = '<w:p><w:r><w:t>The Fox</w:t></w:r></w:p>';
    const matches = search(xml, 'fox', { caseSensitive: true });
    expect(matches.length).to.equal(0);
  });

  test('position mapping on multi-line formatted XML', function () {
    const xml = '<w:p>\n  <w:r>\n    <w:t>hello world</w:t>\n  </w:r>\n</w:p>';
    const matches = search(xml, 'world');
    expect(matches.length).to.equal(1);
    // Line 3 (1-based), column where 'world' starts
    expect(matches[0].matchLine).to.equal(3);
    // After "    <w:t>hello " — that's 15 source chars before 'w'
    expect(matches[0].matchColumn).to.equal(16);
  });

  test('position mapping when match starts after an entity', function () {
    // Source: <w:t>AT&amp;T</w:t> — searching 'T'
    // Decoded: A T & T → matches both Ts but we use case-insensitive default
    // The second 'T' (decoded index 3) sits AFTER the &amp; entity
    const xml = '<w:p><w:r><w:t>AT&amp;T</w:t></w:r></w:p>';
    const matches = searchDocumentText([part(xml)], 'T', { ...defaultOptions, caseSensitive: true });
    expect(matches.length).to.equal(2);
    // <w:p><w:r><w:t> = 15 chars; A is col 16, T is col 17.
    expect(matches[0].matchColumn).to.equal(17);
    // Second T sits after "AT&amp;" — col 16 + 1 (T) + 5 (&amp;) + 1 = 23.
    expect(matches[1].matchColumn).to.equal(23);
  });

  test('position mapping when match spans an entity', function () {
    // Searching 'AT&T' in <w:t>AT&amp;T</w:t>
    // Decoded match length 4, source span 8 (A T & a m p ; T)
    const xml = '<w:p><w:r><w:t>AT&amp;T</w:t></w:r></w:p>';
    const matches = search(xml, 'AT&T');
    expect(matches.length).to.equal(1);
    expect(matches[0].matchEndColumn - matches[0].matchColumn).to.equal(8);
  });

  test('position mapping inside CDATA', function () {
    // CDATA literal — search for "tag" inside "<![CDATA[ <w:t> not a tag </w:t> ]]>"
    // Source columns:
    //   1-5  <w:p>
    //   6-10 <w:r>
    //   11-15 <w:t>
    //   16-24 <![CDATA[   (9 chars, must NOT be counted into match position)
    //   25 ' '
    //   26-30 <w:t>
    //   31 ' ' 32-34 'not' 35 ' ' 36 'a' 37 ' ' 38 't'(ag)
    const xml = '<w:p><w:r><w:t><![CDATA[ <w:t> not a tag </w:t> ]]></w:t></w:r></w:p>';
    const matches = search(xml, 'tag');
    expect(matches.length).to.equal(1);
    expect(matches[0].matchLine).to.equal(1);
    expect(matches[0].matchColumn).to.equal(38);
  });

  test('position mapping for CDATA prefix in mid-segment', function () {
    // Literal "hello" then CDATA "world" — 'w' must land AFTER the <![CDATA[ prefix.
    // Source columns: 1-15 <w:p><w:r><w:t>; 16-20 'hello'; 21-29 <![CDATA[; 30 'w'.
    const xml = '<w:p><w:r><w:t>hello<![CDATA[world]]></w:t></w:r></w:p>';
    const matches = search(xml, 'world');
    expect(matches.length).to.equal(1);
    expect(matches[0].matchColumn).to.equal(30);
  });

  test('position mapping after an astral numeric entity', function () {
    // &#x1F600; is 9 source chars but decodes to a 2-code-unit surrogate
    // pair. The 'X' that follows must report the column AFTER the entity.
    // Source columns: 1-15 <w:p><w:r><w:t>; 16-24 '&#x1F600;'; 25 'X'.
    const xml = '<w:p><w:r><w:t>&#x1F600;X</w:t></w:r></w:p>';
    const matches = searchDocumentText([part(xml)], 'X', { ...defaultOptions, caseSensitive: true });
    expect(matches.length).to.equal(1);
    expect(matches[0].matchColumn).to.equal(25);
    expect(matches[0].matchEndColumn - matches[0].matchColumn).to.equal(1);
  });

  test('empty term returns no results', function () {
    const xml = '<w:p><w:r><w:t>anything</w:t></w:r></w:p>';
    expect(search(xml, '').length).to.equal(0);
    expect(search(xml, '   ').length).to.equal(0);
  });

  test('empty term with all options enabled returns no results', function () {
    const xml = '<w:p><w:r><w:t>anything</w:t></w:r></w:p>';
    const matches = searchDocumentText([part(xml)], '', {
      caseSensitive: true,
      wholeWord: true,
      includeDeletions: true,
    });
    expect(matches).to.deep.equal([]);
  });

  test('w:delText match included when includeDeletions is true', function () {
    const xml = '<w:p><w:r><w:t>kept </w:t></w:r><w:r><w:delText>deleted</w:delText></w:r><w:r><w:t> tail</w:t></w:r></w:p>';
    const without = search(xml, 'deleted');
    expect(without.length).to.equal(0);
    const withDel = search(xml, 'deleted', { includeDeletions: true });
    expect(withDel.length).to.equal(1);
  });

  test('snippet exposes match offsets without inserting bracket markers', function () {
    const xml = '<w:p><w:r><w:t>prefix [bar] suffix and bar elsewhere</w:t></w:r></w:p>';
    const matches = search(xml, 'bar');
    expect(matches.length).to.equal(2);
    // Snippet text must not contain `[..]` markers around the match (the
    // raw text already has its own square brackets in this example).
    const first = matches[0];
    expect(first.snippet).to.contain('[bar]');
    expect(first.snippet.slice(first.snippetMatchStart, first.snippetMatchEnd)).to.equal('bar');
    // The match offsets point at the standalone `bar` between the literal
    // brackets, not at `[bar]`.
    expect(first.snippet.charAt(first.snippetMatchStart - 1)).to.equal('[');
    const second = matches[1];
    expect(second.snippet.slice(second.snippetMatchStart, second.snippetMatchEnd)).to.equal('bar');
  });

  test('multiple parts: results returned in part order', function () {
    const a = part('<w:p><w:r><w:t>alpha foo</w:t></w:r></w:p>', 'word/document.xml');
    const b = part('<w:p><w:r><w:t>beta foo</w:t></w:r></w:p>', 'word/header1.xml');
    const matches = searchDocumentText([a, b], 'foo', defaultOptions);
    expect(matches.length).to.equal(2);
    expect(matches[0].partPath).to.equal('word/document.xml');
    expect(matches[1].partPath).to.equal('word/header1.xml');
  });
});
