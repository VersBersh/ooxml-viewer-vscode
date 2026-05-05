import {
  CancellationToken,
  commands,
  Range,
  Uri,
  Webview,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
} from 'vscode';
import { Match, PartInput, searchDocumentText, SearchOptions } from '../utilities/document-text-search';
import { ExtensionUtilities } from '../utilities/extension-utilities';
import logger from '../utilities/logger';

const VIEW_ID = 'ooxmlViewer.search';
const CONTEXT_KEY = 'ooxmlViewer.searchVisible';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'query'; term: string; options: Partial<SearchOptions> }
  | {
      type: 'accept';
      cacheFilePath: string;
      matchLine: number;
      matchColumn: number;
      matchEndLine: number;
      matchEndColumn: number;
    }
  | { type: 'close' };

export type SearchRefresh = () => Promise<{ parts: PartInput[]; oversized: string[] }>;

/**
 * Hosts the side-panel webview that provides a Find-in-Files-style UI for
 * searching the visible Word document text. The view is shown by setting the
 * `ooxmlViewer.searchVisible` context key — VS Code creates the view lazily
 * via this provider.
 */
export class DocumentSearchViewProvider implements WebviewViewProvider {
  static readonly viewId = VIEW_ID;

  private view: WebviewView | undefined;
  private parts: PartInput[] = [];
  private oversized: string[] = [];
  private viewTitle = 'Search';
  private scopeKey: string | undefined;
  private state: { term: string; options: SearchOptions } = freshState();
  // Callback that re-fetches `parts` + `oversized` from the orchestrator.
  // Set by `show()`. Called by `runQuery()` before each search so results
  // reflect the on-disk state of the cache files (which can change while
  // the search view is open — e.g. the user opens a result, edits it, and
  // saves). On-focus refresh was tried first but webview focus events
  // didn't fire reliably across editor-takes-focus transitions.
  private refresh: SearchRefresh | undefined;
  // Generation counter used to discard the result of an in-flight refresh
  // that has been superseded by a newer one (e.g. user keeps typing while
  // the previous refresh is still reading the cache).
  private refreshGeneration = 0;

  /**
   * @param extensionUri Used to resolve webview asset URIs.
   */
  constructor(private extensionUri: Uri) {}

  /**
   * Set the active scope and reveal the search view, focusing the input.
   *
   * `scopeKey` is the identity of the search scope (typically the OOXML
   * package's file path). When it changes, the persisted term and toggle
   * options are cleared so the input opens empty — matching the spec
   * requirement that reopening a different package starts fresh. When it
   * matches the previous invocation, prior state is preserved (close → X →
   * reopen on the same package re-uses the last query).
   */
  async show(
    scopeKey: string,
    title: string,
    parts: PartInput[],
    oversized: string[],
    refresh?: SearchRefresh,
  ): Promise<void> {
    if (this.scopeKey !== scopeKey) {
      this.state = freshState();
      this.scopeKey = scopeKey;
    }
    this.viewTitle = title;
    this.parts = parts;
    this.oversized = oversized;
    this.refresh = refresh;
    if (this.view) {
      this.view.title = title;
    }
    await commands.executeCommand('setContext', CONTEXT_KEY, true);
    try {
      await commands.executeCommand(`${VIEW_ID}.focus`);
    } catch (err) {
      logger.debug(`Failed to focus search view: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.view) {
      this.postInit();
      if (this.state.term.trim() !== '') {
        this.runSearch();
      }
    }
  }

  /**
   * Hide the search view and bring the parts tree back into focus.
   */
  async close(): Promise<void> {
    await commands.executeCommand('setContext', CONTEXT_KEY, false);
  }

  /**
   * Force a refresh of the underlying parts and re-run the active search.
   * Used by the toolbar Refresh button.
   */
  async manualRefresh(): Promise<void> {
    await this.refreshNow();
    if (this.state.term.trim() !== '') {
      this.runSearch();
    }
  }

  /**
   * Called by the orchestrator after a save/external-change has produced
   * a fresh PartInput snapshot. Replaces the in-memory parts and re-runs
   * the active search so results auto-update without the user having to
   * retype.
   */
  notifySnapshotRefreshed(parts: PartInput[], oversized: string[]): void {
    this.parts = parts;
    this.oversized = oversized;
    if (this.state.term.trim() !== '') {
      this.runSearch();
    }
  }

  resolveWebviewView(view: WebviewView, _ctx: WebviewViewResolveContext, _tok: CancellationToken): void {
    this.view = view;
    view.title = this.viewTitle;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.extensionUri, 'resources', 'search-view')],
    };
    view.webview.html = this.buildHtml(view.webview);
    // Wrap handleMessage so exceptions are logged instead of becoming
    // unhandled rejections that VS Code silently swallows.
    view.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      try {
        await this.handleMessage(msg);
      } catch (err) {
        logger.error(`Search-view message handler threw on '${msg?.type}': ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  private postInit(): void {
    this.view?.webview.postMessage({
      type: 'init',
      term: this.state.term,
      options: this.state.options,
      oversized: this.oversized,
    });
  }

  private postResults(matches: Match[]): void {
    this.view?.webview.postMessage({
      type: 'results',
      matches,
      oversized: this.oversized,
    });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.postInit();
        if (this.state.term.trim() !== '') {
          this.runSearch();
        }
        break;
      case 'query':
        this.state.term = typeof msg.term === 'string' ? msg.term : '';
        this.state.options = {
          caseSensitive: !!msg.options?.caseSensitive,
          wholeWord: !!msg.options?.wholeWord,
          includeDeletions: !!msg.options?.includeDeletions,
        };
        // Refresh first so the search reflects any cache-file edits the
        // user made between keystrokes (e.g. opened a result, edited it,
        // saved it). This is debounced upstream by the webview.
        await this.refreshNow();
        this.runSearch();
        break;
      case 'accept':
        if (typeof msg.cacheFilePath === 'string') {
          const range = new Range(
            msg.matchLine - 1,
            msg.matchColumn - 1,
            msg.matchEndLine - 1,
            msg.matchEndColumn - 1,
          );
          await ExtensionUtilities.openFileAtRange(msg.cacheFilePath, range);
        }
        break;
      case 'close':
        await this.close();
        break;
    }
  }

  private async refreshNow(): Promise<void> {
    if (!this.refresh) {
      return;
    }
    const gen = ++this.refreshGeneration;
    try {
      const fresh = await this.refresh();
      if (gen !== this.refreshGeneration) {
        // A newer refresh was started; let it win.
        return;
      }
      this.parts = fresh.parts;
      this.oversized = fresh.oversized;
    } catch (err) {
      logger.error(`Search-view refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private runSearch(): void {
    if (this.state.term.trim() === '') {
      this.postResults([]);
      return;
    }
    const matches = searchDocumentText(this.parts, this.state.term, this.state.options);
    this.postResults(matches);
  }

  private buildHtml(webview: Webview): string {
    const mediaRoot = Uri.joinPath(this.extensionUri, 'resources', 'search-view');
    const cssUri = webview.asWebviewUri(Uri.joinPath(mediaRoot, 'search.css'));
    const jsUri = webview.asWebviewUri(Uri.joinPath(mediaRoot, 'search.js'));
    const nonce = randomNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div class="toolbar">
    <input id="term" type="text" placeholder="Type to search across w:t elements" autocomplete="off" spellcheck="false" />
    <button id="case" class="toggle" title="Match Case" aria-pressed="false"><span class="icon">Aa</span></button>
    <button id="word" class="toggle" title="Match Whole Word" aria-pressed="false"><span class="icon">|ab|</span></button>
    <button id="del"  class="toggle" title="Include Revision Deletions" aria-pressed="false"><span class="icon">+&minus;</span></button>
  </div>
  <div id="results" class="results">
    <div class="hint">Type to search across w:t elements</div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function freshState(): { term: string; options: SearchOptions } {
  return {
    term: '',
    options: { caseSensitive: false, wholeWord: false, includeDeletions: false },
  };
}

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}
