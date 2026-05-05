import { expect } from 'chai';
import { SinonSpy, SinonStub, spy, stub } from 'sinon';
import { CancellationToken, commands, EventEmitter, Uri, Webview, WebviewView, WebviewViewResolveContext } from 'vscode';
import { DocumentSearchViewProvider } from '../../../src/search-view/document-search-view-provider';
import { PartInput } from '../../../src/utilities/document-text-search';
import { ExtensionUtilities } from '../../../src/utilities/extension-utilities';

type Listener<T> = (msg: T) => void;

interface FakeWebview extends Partial<Webview> {
  postMessage: SinonSpy;
  cspSource: string;
  asWebviewUri: (u: Uri) => Uri;
  options: object;
  html: string;
  onDidReceiveMessage: (l: Listener<unknown>) => { dispose(): void };
  __emit: (msg: unknown) => Promise<void>;
}

function fakeWebview(): FakeWebview {
  let listener: Listener<unknown> | undefined;
  const postMessageSpy = spy();
  const wv: FakeWebview = {
    postMessage: postMessageSpy,
    cspSource: 'vscode-webview://test',
    asWebviewUri: (u: Uri) => u,
    options: {},
    html: '',
    onDidReceiveMessage: (l: Listener<unknown>) => {
      listener = l;
      return { dispose: () => undefined };
    },
    __emit: async (msg: unknown) => {
      if (listener) {
        await listener(msg);
      }
    },
  };
  return wv;
}

function fakeView(webview: FakeWebview): WebviewView & { __disposeEmitter: EventEmitter<void> } {
  const disposeEmitter = new EventEmitter<void>();
  return {
    viewType: DocumentSearchViewProvider.viewId,
    webview: webview as unknown as Webview,
    title: '',
    description: undefined,
    badge: undefined,
    visible: true,
    show: () => undefined,
    onDidChangeVisibility: new EventEmitter<void>().event,
    onDidDispose: disposeEmitter.event,
    __disposeEmitter: disposeEmitter,
  } as unknown as WebviewView & { __disposeEmitter: EventEmitter<void> };
}

function part(partPath: string, xml: string): PartInput {
  return { partPath, cacheFilePath: `cache/${partPath}`, xml };
}

suite('DocumentSearchViewProvider', function () {
  let executeCommandStub: SinonStub;
  const stubs: SinonStub[] = [];

  setup(function () {
    executeCommandStub = stub(commands, 'executeCommand').resolves();
    stubs.push(executeCommandStub);
  });

  teardown(function () {
    stubs.forEach(s => s.restore());
    stubs.length = 0;
  });

  function newProvider() {
    return new DocumentSearchViewProvider(Uri.file('C:/extension'));
  }

  function resolve(provider: DocumentSearchViewProvider) {
    const wv = fakeWebview();
    const view = fakeView(wv);
    provider.resolveWebviewView(view, {} as WebviewViewResolveContext, {} as CancellationToken);
    return { wv, view };
  }

  test('show() sets the searchVisible context key and focuses the view', async function () {
    const provider = newProvider();
    await provider.show('package-A', 'Search title', [], []);
    const setContextCalls = executeCommandStub.getCalls().filter(c => c.args[0] === 'setContext');
    expect(setContextCalls.length).to.equal(1);
    expect(setContextCalls[0].args[1]).to.equal('ooxmlViewer.searchVisible');
    expect(setContextCalls[0].args[2]).to.equal(true);
    const focusCalls = executeCommandStub.getCalls().filter(c => c.args[0] === 'ooxmlViewer.search.focus');
    expect(focusCalls.length).to.equal(1);
  });

  test('close() clears the searchVisible context key', async function () {
    const provider = newProvider();
    await provider.close();
    const setContextCalls = executeCommandStub.getCalls().filter(c => c.args[0] === 'setContext');
    expect(setContextCalls.length).to.equal(1);
    expect(setContextCalls[0].args[2]).to.equal(false);
  });

  test('ready message responds with init carrying the persisted state', async function () {
    const provider = newProvider();
    await provider.show('package-A', 't', [], ['word/big.xml']);
    const { wv } = resolve(provider);
    await wv.__emit({ type: 'ready' });
    const initCalls = wv.postMessage.getCalls().filter(c => (c.args[0] as { type: string }).type === 'init');
    expect(initCalls.length).to.be.greaterThan(0);
    const init = initCalls[initCalls.length - 1].args[0];
    expect(init.term).to.equal('');
    expect(init.options).to.deep.equal({ caseSensitive: false, wholeWord: false, includeDeletions: false });
    expect(init.oversized).to.deep.equal(['word/big.xml']);
  });

  test('query message runs the search and posts results', async function () {
    const provider = newProvider();
    const parts = [part('word/document.xml', '<w:p><w:r><w:t>the quick brown fox</w:t></w:r></w:p>')];
    await provider.show('package-A', 't', parts, []);
    const { wv } = resolve(provider);
    await wv.__emit({
      type: 'query',
      term: 'quick',
      options: { caseSensitive: false, wholeWord: false, includeDeletions: false },
    });
    const resultsCalls = wv.postMessage.getCalls().filter(c => (c.args[0] as { type: string }).type === 'results');
    expect(resultsCalls.length).to.equal(1);
    const payload = resultsCalls[0].args[0];
    expect(payload.matches.length).to.equal(1);
    expect(payload.matches[0].partPath).to.equal('word/document.xml');
    expect(payload.oversized).to.deep.equal([]);
  });

  test('query with empty term posts an empty results array', async function () {
    const provider = newProvider();
    const parts = [part('word/document.xml', '<w:p><w:r><w:t>foo</w:t></w:r></w:p>')];
    await provider.show('package-A', 't', parts, []);
    const { wv } = resolve(provider);
    await wv.__emit({
      type: 'query',
      term: '',
      options: { caseSensitive: false, wholeWord: false, includeDeletions: false },
    });
    const resultsCalls = wv.postMessage.getCalls().filter(c => (c.args[0] as { type: string }).type === 'results');
    expect(resultsCalls.length).to.equal(1);
    expect(resultsCalls[0].args[0].matches).to.deep.equal([]);
  });

  test('accept message opens the cache file at the given range', async function () {
    const provider = newProvider();
    const openStub = stub(ExtensionUtilities, 'openFileAtRange').resolves();
    stubs.push(openStub);
    await provider.show('package-A', 't', [], []);
    const { wv } = resolve(provider);
    await wv.__emit({
      type: 'accept',
      cacheFilePath: 'cache/word/document.xml',
      matchLine: 3,
      matchColumn: 5,
      matchEndLine: 3,
      matchEndColumn: 8,
    });
    expect(openStub.callCount).to.equal(1);
    expect(openStub.args[0][0]).to.equal('cache/word/document.xml');
    const range = openStub.args[0][1];
    expect(range.start.line).to.equal(2);
    expect(range.start.character).to.equal(4);
    expect(range.end.line).to.equal(2);
    expect(range.end.character).to.equal(7);
  });

  test('term and options persist across resolve cycles for the same scope', async function () {
    const provider = newProvider();
    const parts = [part('word/document.xml', '<w:p><w:r><w:t>FOO foo</w:t></w:r></w:p>')];
    await provider.show('package-A', 't', parts, []);
    const first = resolve(provider);
    await first.wv.__emit({
      type: 'query',
      term: 'foo',
      options: { caseSensitive: true, wholeWord: false, includeDeletions: false },
    });
    // Simulate the user closing and re-opening the search view on the same package
    first.view.__disposeEmitter.fire();
    await provider.show('package-A', 't', parts, []);
    const second = resolve(provider);
    await second.wv.__emit({ type: 'ready' });
    const initCalls = second.wv.postMessage.getCalls().filter(c => (c.args[0] as { type: string }).type === 'init');
    expect(initCalls.length).to.equal(1);
    const init = initCalls[0].args[0];
    expect(init.term).to.equal('foo');
    expect(init.options.caseSensitive).to.equal(true);
  });

  test('state resets when the scope key changes', async function () {
    const provider = newProvider();
    const parts = [part('word/document.xml', '<w:p><w:r><w:t>foo</w:t></w:r></w:p>')];
    await provider.show('package-A', 't', parts, []);
    const a = resolve(provider);
    await a.wv.__emit({
      type: 'query',
      term: 'foo',
      options: { caseSensitive: true, wholeWord: true, includeDeletions: true },
    });
    a.view.__disposeEmitter.fire();

    // Switching to a different package should reset term + options.
    await provider.show('package-B', 't', parts, []);
    const b = resolve(provider);
    await b.wv.__emit({ type: 'ready' });
    const initCalls = b.wv.postMessage.getCalls().filter(c => (c.args[0] as { type: string }).type === 'init');
    expect(initCalls.length).to.equal(1);
    const init = initCalls[0].args[0];
    expect(init.term).to.equal('');
    expect(init.options).to.deep.equal({ caseSensitive: false, wholeWord: false, includeDeletions: false });
  });

  test('each query refreshes the parts before searching', async function () {
    const provider = newProvider();
    const oldParts = [part('word/document.xml', '<w:p><w:r><w:t>oldcontent</w:t></w:r></w:p>')];
    const newParts = [part('word/document.xml', '<w:p><w:r><w:t>newcontent</w:t></w:r></w:p>')];
    const refresh = spy(async () => ({ parts: newParts, oversized: [] }));
    await provider.show('package-A', 't', oldParts, [], refresh);
    const { wv } = resolve(provider);

    await wv.__emit({
      type: 'query',
      term: 'newcontent',
      options: { caseSensitive: false, wholeWord: false, includeDeletions: false },
    });

    expect(refresh.callCount).to.equal(1);
    const resultsCalls = wv.postMessage.getCalls().filter(c => (c.args[0] as { type: string }).type === 'results');
    const last = resultsCalls[resultsCalls.length - 1].args[0];
    expect(last.matches.length).to.equal(1);
    expect(last.matches[0].partPath).to.equal('word/document.xml');
  });

  test('manualRefresh re-fetches and re-runs the active search', async function () {
    const provider = newProvider();
    const oldParts = [part('word/document.xml', '<w:p><w:r><w:t>oldcontent</w:t></w:r></w:p>')];
    const newParts = [part('word/document.xml', '<w:p><w:r><w:t>newcontent</w:t></w:r></w:p>')];
    let useNew = false;
    const refresh = spy(async () => ({ parts: useNew ? newParts : oldParts, oversized: [] }));
    await provider.show('package-A', 't', oldParts, [], refresh);
    const { wv } = resolve(provider);

    // Initial query against oldParts (refresh returns oldParts on the first call).
    await wv.__emit({
      type: 'query',
      term: 'newcontent',
      options: { caseSensitive: false, wholeWord: false, includeDeletions: false },
    });
    let resultsCalls = wv.postMessage.getCalls().filter(c => (c.args[0] as { type: string }).type === 'results');
    expect(resultsCalls[resultsCalls.length - 1].args[0].matches.length).to.equal(0);

    // Underlying file changes; user clicks Refresh button.
    useNew = true;
    await provider.manualRefresh();

    resultsCalls = wv.postMessage.getCalls().filter(c => (c.args[0] as { type: string }).type === 'results');
    const last = resultsCalls[resultsCalls.length - 1].args[0];
    expect(last.matches.length).to.equal(1);
  });

  test('an in-flight refresh is discarded if a newer one starts before it resolves', async function () {
    const provider = newProvider();
    const slowParts = [part('word/document.xml', '<w:p><w:r><w:t>SLOW</w:t></w:r></w:p>')];
    const fastParts = [part('word/document.xml', '<w:p><w:r><w:t>FAST</w:t></w:r></w:p>')];
    let releaseSlow!: () => void;
    const slowPromise = new Promise<void>(r => { releaseSlow = r; });
    let callCount = 0;
    const refresh: () => Promise<{ parts: PartInput[]; oversized: string[] }> = async () => {
      callCount++;
      if (callCount === 1) {
        await slowPromise;
        return { parts: slowParts, oversized: [] };
      }
      return { parts: fastParts, oversized: [] };
    };

    await provider.show('package-A', 't', [], [], refresh);
    const { wv } = resolve(provider);

    // First query (slow refresh in-flight). Don't await — capture the promise.
    const firstQuery = wv.__emit({
      type: 'query',
      term: 'SLOW',
      options: { caseSensitive: true, wholeWord: false, includeDeletions: false },
    });

    // Second query starts a fast refresh that resolves immediately.
    await wv.__emit({
      type: 'query',
      term: 'FAST',
      options: { caseSensitive: true, wholeWord: false, includeDeletions: false },
    });

    // Now release the first refresh. Its result must be discarded.
    releaseSlow();
    await firstQuery;

    // Issue another query so we can read the post-refresh parts.
    await wv.__emit({
      type: 'query',
      term: 'SLOW',
      options: { caseSensitive: true, wholeWord: false, includeDeletions: false },
    });
    const resultsCalls = wv.postMessage.getCalls().filter(c => (c.args[0] as { type: string }).type === 'results');
    const last = resultsCalls[resultsCalls.length - 1].args[0];
    // The fast refresh's `fastParts` won, so 'SLOW' should NOT match.
    expect(last.matches.length).to.equal(0);
  });
});
