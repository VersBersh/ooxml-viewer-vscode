/* eslint-env browser */
/* global acquireVsCodeApi */

(function () {
  const vscode = acquireVsCodeApi();
  const term = document.getElementById('term');
  const caseBtn = document.getElementById('case');
  const wordBtn = document.getElementById('word');
  const delBtn = document.getElementById('del');
  const results = document.getElementById('results');

  const state = {
    options: { caseSensitive: false, wholeWord: false, includeDeletions: false },
    matches: [],
    oversized: [],
    focusedIndex: -1,
  };

  let debounceHandle = null;
  function debouncedQuery() {
    if (debounceHandle) {
      clearTimeout(debounceHandle);
    }
    debounceHandle = setTimeout(() => {
      vscode.postMessage({ type: 'query', term: term.value, options: state.options });
    }, 150);
  }

  function setToggle(btn, key) {
    btn.addEventListener('click', () => {
      state.options[key] = !state.options[key];
      btn.setAttribute('aria-pressed', state.options[key] ? 'true' : 'false');
      debouncedQuery();
      term.focus();
    });
  }
  setToggle(caseBtn, 'caseSensitive');
  setToggle(wordBtn, 'wholeWord');
  setToggle(delBtn, 'includeDeletions');

  term.addEventListener('input', debouncedQuery);
  term.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      acceptFocused();
    }
  });

  function applyOptions(o) {
    state.options = {
      caseSensitive: !!(o && o.caseSensitive),
      wholeWord: !!(o && o.wholeWord),
      includeDeletions: !!(o && o.includeDeletions),
    };
    caseBtn.setAttribute('aria-pressed', state.options.caseSensitive ? 'true' : 'false');
    wordBtn.setAttribute('aria-pressed', state.options.wholeWord ? 'true' : 'false');
    delBtn.setAttribute('aria-pressed', state.options.includeDeletions ? 'true' : 'false');
  }

  // The match span is given as `[matchStart, matchEnd)` offsets into the
  // snippet text. The host doesn't insert any markup; the webview is
  // responsible for highlighting. This avoids ambiguity when the source text
  // itself contains `[` or `]`.
  function renderSnippetInto(node, snippet, matchStart, matchEnd) {
    if (
      typeof matchStart !== 'number' ||
      typeof matchEnd !== 'number' ||
      matchStart < 0 ||
      matchEnd <= matchStart ||
      matchEnd > snippet.length
    ) {
      node.textContent = snippet;
      return;
    }
    node.appendChild(document.createTextNode(snippet.slice(0, matchStart)));
    const matchedSpan = document.createElement('span');
    matchedSpan.className = 'match';
    matchedSpan.textContent = snippet.slice(matchStart, matchEnd);
    node.appendChild(matchedSpan);
    node.appendChild(document.createTextNode(snippet.slice(matchEnd)));
  }

  function render() {
    results.innerHTML = '';
    if (!term.value || term.value.trim() === '') {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = 'Type to search across w:t elements';
      results.appendChild(hint);
      renderOversized();
      return;
    }
    if (state.matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No results in this package';
      results.appendChild(empty);
      renderOversized();
      return;
    }
    // Group consecutive runs by partPath (matches are already in part order).
    const groups = [];
    let currentGroup = null;
    state.matches.forEach((m, idx) => {
      if (!currentGroup || currentGroup.partPath !== m.partPath) {
        currentGroup = { partPath: m.partPath, items: [] };
        groups.push(currentGroup);
      }
      currentGroup.items.push({ match: m, flatIndex: idx });
    });

    for (const g of groups) {
      const group = document.createElement('div');
      group.className = 'group';
      const header = document.createElement('div');
      header.className = 'group-header';
      const chev = document.createElement('span');
      chev.className = 'chevron';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = g.partPath;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = g.items.length + ' result' + (g.items.length === 1 ? '' : 's');
      header.appendChild(chev);
      header.appendChild(name);
      header.appendChild(count);
      header.addEventListener('click', () => group.classList.toggle('collapsed'));
      group.appendChild(header);
      const body = document.createElement('div');
      body.className = 'group-body';
      for (const item of g.items) {
        const row = document.createElement('div');
        row.className = 'result';
        row.dataset.index = String(item.flatIndex);
        const snip = document.createElement('span');
        snip.className = 'snippet';
        renderSnippetInto(snip, item.match.snippet, item.match.snippetMatchStart, item.match.snippetMatchEnd);
        const pos = document.createElement('span');
        pos.className = 'pos';
        pos.textContent = item.match.matchLine + ':' + item.match.matchColumn;
        row.appendChild(snip);
        row.appendChild(pos);
        row.addEventListener('click', () => acceptIndex(item.flatIndex));
        body.appendChild(row);
      }
      group.appendChild(body);
      results.appendChild(group);
    }
    renderOversized();
  }

  function renderOversized() {
    if (!state.oversized || state.oversized.length === 0) {
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'oversized';
    const title = document.createElement('div');
    title.className = 'oversized-title';
    title.textContent =
      'Skipped ' + state.oversized.length + ' oversized part' + (state.oversized.length === 1 ? '' : 's') + ':';
    wrap.appendChild(title);
    const list = document.createElement('div');
    list.className = 'oversized-list';
    for (const p of state.oversized) {
      const row = document.createElement('div');
      row.textContent = p;
      list.appendChild(row);
    }
    wrap.appendChild(list);
    results.appendChild(wrap);
  }

  function setFocused(idx) {
    const all = results.querySelectorAll('.result');
    all.forEach((r) => r.classList.remove('focused'));
    if (idx < 0 || idx >= all.length) {
      state.focusedIndex = -1;
      return;
    }
    state.focusedIndex = idx;
    const row = all[idx];
    row.classList.add('focused');
    row.scrollIntoView({ block: 'nearest' });
  }

  function moveFocus(delta) {
    const all = results.querySelectorAll('.result');
    if (all.length === 0) {
      return;
    }
    let next = state.focusedIndex + delta;
    if (next < 0) {
      next = 0;
    }
    if (next >= all.length) {
      next = all.length - 1;
    }
    setFocused(next);
  }

  function acceptIndex(idx) {
    if (idx < 0 || idx >= state.matches.length) {
      return;
    }
    const m = state.matches[idx];
    vscode.postMessage({
      type: 'accept',
      partPath: m.partPath,
      cacheFilePath: m.cacheFilePath,
      matchLine: m.matchLine,
      matchColumn: m.matchColumn,
      matchEndLine: m.matchEndLine,
      matchEndColumn: m.matchEndColumn,
    });
  }

  function acceptFocused() {
    if (state.focusedIndex >= 0) {
      acceptIndex(state.focusedIndex);
    } else if (state.matches.length > 0) {
      acceptIndex(0);
    }
  }

  window.addEventListener('message', (evt) => {
    const msg = evt.data;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    if (msg.type === 'init') {
      term.value = msg.term || '';
      applyOptions(msg.options);
      state.oversized = msg.oversized || [];
      render();
      term.focus();
      term.select();
    } else if (msg.type === 'results') {
      state.matches = msg.matches || [];
      if (msg.oversized) {
        state.oversized = msg.oversized;
      }
      state.focusedIndex = -1;
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
