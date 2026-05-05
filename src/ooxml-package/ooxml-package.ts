import { basename, extname } from 'path';
import { OOXMLExtensionSettings } from '../ooxml-extension-settings';
import { DocumentSearchViewProvider } from '../search-view/document-search-view-provider';
import { FileNode, FileNodeType } from '../tree-view/ooxml-tree-view-provider';
import { PartInput } from '../utilities/document-text-search';
import { ExtensionUtilities } from '../utilities/extension-utilities';
import { FileSystemUtilities } from '../utilities/file-system-utilities';
import logger from '../utilities/logger';
import { RemoveOOXMLCommand } from '../utilities/ooxml-commands';
import { XmlFormatter } from '../utilities/xml-formatter';
import { OOXMLPackageFileAccessor } from './ooxml-package-file-accessor';
import { OOXMLPackageFileCache } from './ooxml-package-file-cache';
import { OOXMLPackageTreeView } from './ooxml-package-tree-view';

type SearchPartCacheEntry = {
  mtime: number;
  size: number;
  oversized: boolean;
  part?: PartInput;
};

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

const WORD_PACKAGE_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.dotm']);
const SEARCHABLE_PART_PATTERN = /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/;
const textDecoder = new TextDecoder();

/**
 * The OOXML Package
 */
export class OOXMLPackage {
  // Whether or not this is the first time the file has been populated
  //  (Should the new file label (asterisk) be shown when creating a new file node).
  private isFirstOpen: boolean;
  private packageName: string;
  // True iff our own `updatePackage` write is the one that's about to fire
  // the .docx file watcher. Set BEFORE the write; consumed by the watcher
  // on the next fire. Without this, every save triggers a 30+ second
  // re-extract via populateOOXMLViewer for a package whose cache is
  // already correct.
  private suppressNextWatcherFire = false;
  // Active search provider, set when the user invokes Search Document Text.
  // Used to push fresh parts after a save-driven prewarm so search results
  // auto-update without the user re-typing.
  private activeSearchProvider: DocumentSearchViewProvider | undefined;
  // Per-part snapshot of the formatted cache file, keyed by part path.
  // `gatherSearchParts` checks the file's (mtime, size) and reuses the
  // cached `PartInput` when nothing has changed — this is what makes the
  // refresh-on-every-query design viable for packages with multi-100KB
  // parts. Without this, every keystroke would re-run the XML formatter on
  // every part.
  private searchPartCache: Map<string, SearchPartCacheEntry> = new Map();
  // De-duplicates in-flight `gatherOneSearchPart` calls. When a query
  // fires while a previous gather for the same part is still running (e.g.
  // duplicate query messages, or a pre-warm racing a user query), the
  // second caller awaits the first instead of running its own format pass.
  private inFlightGather: Map<string, Promise<{ path: string; part?: PartInput; oversized: boolean }>> = new Map();

  /**
   * Constructs an instance of OOXMLPackage.
   *
   * @constructor
   * @param {string} ooxmlFilePath The path to the ooxml file.
   * @param {OOXMLPackageFileAccessor} ooxmlFileAccessor The ooxml package file accessor.
   * @param {OOXMLPackageTreeView} treeView The package tree view.
   * @param {OOXMLPackageFileCache} cache The file cache for the ooxml package.
   * @param {OOXMLExtensionSettings} extensionSettings The extension settings.
   */
  constructor(
    private ooxmlFilePath: string,
    private ooxmlFileAccessor: OOXMLPackageFileAccessor,
    private treeView: OOXMLPackageTreeView,
    private cache: OOXMLPackageFileCache,
    private extensionSettings: OOXMLExtensionSettings,
  ) {
    this.isFirstOpen = true;
    this.packageName = basename(ooxmlFilePath);
  }

  /**
   * Displays and formats the selected file.
   *
   * @param {string} filePath The selected file node's file path
   */
  async viewFile(filePath: string): Promise<void> {
    try {
      await ExtensionUtilities.withProgress(async () => {
        await this.formatXml(filePath);

        const fileCachePath = this.cache.getNormalFileCachePath(filePath);
        await ExtensionUtilities.openFile(fileCachePath);
      }, `Opening ${filePath}`);
    } catch (err) {
      await ExtensionUtilities.showError(err);
    }
  }

  /**
   * Opens a window showing the difference between the primary xml part and the compare xml part.
   *
   * @param {string} filePath The path of the file to be diffed.
   */
  async getDiff(filePath: string): Promise<void> {
    try {
      // format the file
      await this.formatXml(filePath);

      // diff the primary and compare files
      const fileCachePath = this.cache.getNormalFileCachePath(filePath);
      const fileCompareCachePath = this.cache.getCompareFileCachePath(filePath);
      const title = `${basename(fileCachePath)} ↔ compare.${basename(fileCompareCachePath)}`;

      await ExtensionUtilities.openDiff(fileCompareCachePath, fileCachePath, title);
    } catch (err) {
      await ExtensionUtilities.showError(err);
    }
  }

  /**
   * Format the document if it is a cached normal file.
   *
   * @param {string} filePath The file path to format.
   */
  async tryFormatDocument(filePath: string): Promise<void> {
    try {
      if (this.cache.cachePathIsNormal(filePath)) {
        await ExtensionUtilities.withProgress(
          async () => {
            await this.formatXml(this.cache.getFilePathFromCacheFilePath(filePath));
          },
          `Formatting '${basename(filePath)}'`,
        );
      } else {
        logger.debug(`Unable to format file '${filePath}' since file is not in cache path`);
      }
    } catch (err) {
      await ExtensionUtilities.showError(err);
    }
  }

  /**
   * Search OOXML parts for a string and display the results in the search.
   */
  async searchOOXMLParts(): Promise<void> {
    try {
      const searchTerm = await ExtensionUtilities.showInput(`Search '${this.packageName}' OOXML Parts`, 'Enter a search term.');
      if (!searchTerm) {
        logger.warn('No search term provided');
        return;
      }

      logger.info(`Using search term '${searchTerm}'`);
      await ExtensionUtilities.findInFiles(searchTerm, this.cache.normalSubfolderPath);
    } catch (err) {
      await ExtensionUtilities.showError(err);
    }
  }

  /**
   * Searches the visible text of the package's Word parts via the side-panel
   * search view. If `filePath` is provided, only that part is searched;
   * otherwise all eligible Word parts (document.xml, headers, footers,
   * footnotes, endnotes, comments) are searched.
   *
   * @param {string | undefined} filePath The single part to search, or undefined to search the whole package.
   * @param {DocumentSearchViewProvider} searchProvider The view provider that hosts the search UI.
   */
  /**
   * Called by the file watcher to check whether the next change event was
   * caused by our own `updatePackage` write. If so, the watcher should
   * skip its re-extract (`populateOOXMLViewer`) — the cache is already in
   * the correct state. Returns true and clears the flag if suppressed.
   */
  consumeSuppressedWatcherFire(): boolean {
    if (this.suppressNextWatcherFire) {
      this.suppressNextWatcherFire = false;
      return true;
    }
    return false;
  }

  async searchDocumentText(filePath: string | undefined, searchProvider: DocumentSearchViewProvider): Promise<void> {
    try {
      const ext = extname(this.ooxmlFilePath).toLowerCase();
      if (!WORD_PACKAGE_EXTENSIONS.has(ext)) {
        await ExtensionUtilities.showWarning(
          `Document text search is only supported for Word packages (${[...WORD_PACKAGE_EXTENSIONS].join(', ')}).`,
        );
        return;
      }

      let candidatePaths: string[];
      if (filePath !== undefined) {
        if (extname(filePath).toLowerCase() !== '.xml') {
          await ExtensionUtilities.showWarning(`Document text search requires an XML part.`);
          return;
        }
        candidatePaths = [filePath];
      } else {
        candidatePaths = this.getSearchableParts();
      }

      let initial: { parts: PartInput[]; oversized: string[] } = { parts: [], oversized: [] };

      await ExtensionUtilities.withProgress(async () => {
        initial = await this.gatherSearchParts(candidatePaths);
      }, 'Formatting parts for search...');

      // Track the provider so we can push fresh data after a save (see
      // `updateOOXMLFile`'s prewarm path).
      this.activeSearchProvider = searchProvider;

      // Refresh callback runs on every query in the search view. It re-runs
      // the same gather pipeline so the search picks up cache-file edits
      // and external package re-saves without forcing a re-keystroke loop.
      // Runs silently (no progress UI) because the user isn't waiting on it.
      const refresh = (): Promise<{ parts: PartInput[]; oversized: string[] }> => this.gatherSearchParts(candidatePaths);

      await searchProvider.show(
        this.ooxmlFilePath,
        `Search '${this.packageName}' document text`,
        initial.parts,
        initial.oversized,
        refresh,
      );
    } catch (err) {
      await ExtensionUtilities.showError(err);
    }
  }

  /**
   * Loads the selected OOXML file into the tree view.
   */
  async openOOXMLPackage(): Promise<void> {
    try {
      await ExtensionUtilities.withProgress(async () => {
        // load ooxml file and populate the viewer
        await this.cache.initialize();
        await this.ooxmlFileAccessor.load();
        await this.populateOOXMLViewer();
      }, `Unpacking '${this.packageName}'`);
    } catch (err) {
      await ExtensionUtilities.showError(err);
    }
  }

  /**
   * Writes changes to OOXML file being inspected when one of its parts is saved.
   * Note that this will trigger `reloadOOXMLFile` to fire if changes are written.
   *
   * @param {string} cacheFilePath The path of the xml part that was updated.
   */
  async updateOOXMLFile(cacheFilePath: string): Promise<void> {
    try {
      if (!this.cache.cachePathIsNormal(cacheFilePath)) {
        logger.debug(`Not updating OOXML file '${cacheFilePath}' since it is not in the normal cache path`);
        return;
      }

      const filePath = this.cache.getFilePathFromCacheFilePath(cacheFilePath);
      logger.debug(`Updating OOXML file '${filePath}'`);

      const fileContents = await this.cache.getCachedNormalFile(filePath);
      const prevFileContents = await this.cache.getCachedPrevFile(filePath);
      if (XmlFormatter.areEqual(fileContents, prevFileContents)) {
        logger.debug('Normal and prev file contents match. OOXML package will not be updated');
        return;
      }

      const fileMinXml = XmlFormatter.minify(fileContents, this.extensionSettings.preserveComments);

      // Tell the watcher to ignore the next change event for the .docx
      // file — we know we're about to write it ourselves and the cache is
      // already in the correct state. Without this, the watcher fires
      // populateOOXMLViewer which spends 30+ seconds re-extracting on big
      // packages. Set BEFORE the await: the watcher's change event is
      // queued asynchronously and could otherwise run before this line.
      this.suppressNextWatcherFire = true;
      // Safety net: if the watcher event never arrives, don't leave the
      // flag set forever — that would silently swallow a real external
      // change. 2s is well beyond typical watcher latency (<100ms).
      setTimeout(() => {
        this.suppressNextWatcherFire = false;
      }, 2000);
      let success: boolean;
      try {
        success = await this.ooxmlFileAccessor.updatePackage(filePath, fileMinXml);
      } catch (err) {
        this.suppressNextWatcherFire = false;
        throw err;
      }
      if (!success) {
        this.suppressNextWatcherFire = false;
        await ExtensionUtilities.showWarning(
          `File not saved.\n'${this.packageName}' is open in another program.\nClose that program before making any changes.`,
          true,
        );

        await ExtensionUtilities.makeActiveTextEditorDirty();
        return;
      }

      await this.cache.createCachedFiles(filePath, fileContents);

      this.treeView.refresh();

      // Pre-warm the search snapshot. The .docx watcher will normally
      // bypass populateOOXMLViewer for this self-write (see the suppression
      // flag above), so this is the only chance to refresh the snapshot
      // and push fresh results into an open search view.
      this.prewarmSearchCache();
    } catch (err) {
      await ExtensionUtilities.showError(err);
    }
  }

  /**
   * Removes the OOXML package from the tree view.
   */
  async removePackage(): Promise<void> {
    try {
      await ExtensionUtilities.withProgress(async () => {
        await ExtensionUtilities.dispatch(new RemoveOOXMLCommand(this.treeView.getRootFileNode()));
      }, `Removing '${this.packageName}'`);
    } catch (err) {
      await ExtensionUtilities.showError(err);
    }
  }

  /**
   * Creates or updates tree view file nodes and creates cache files for comparison.
   */
  private async populateOOXMLViewer(): Promise<void> {
    logger.debug('Populating OOXML Viewer');
    const fileContents = await this.ooxmlFileAccessor.getPackageContents();

    const ooxmlContentsLength = fileContents.length;
    if (ooxmlContentsLength > this.extensionSettings.maximumNumberOfOOXMLParts) {
      ExtensionUtilities.showWarning(
        `'${this.packageName}' number of parts of '${ooxmlContentsLength}' exceeds the maximum of '${this.extensionSettings.maximumNumberOfOOXMLParts}'`,
      );
      await ExtensionUtilities.dispatch(new RemoveOOXMLCommand(this.treeView.getRootFileNode()));
      return;
    }

    for (const file of fileContents) {
      // ignore folder files
      if (file.isDirectory) {
        continue;
      }

      // Build nodes for each file in the package

      let fileNodeAlreadyExists = true;
      let currentFileNode = this.treeView.getRootFileNode();
      const names: string[] = file.filePath.split('/');
      for (let i = 0; i < names.length; i++) {
        const fileOrFolderPath = names.slice(0, i + 1).join('/');
        const existingFileNode = currentFileNode.children.find(c => c.nodePath === fileOrFolderPath);
        if (existingFileNode) {
          currentFileNode = existingFileNode;
        } else {
          fileNodeAlreadyExists = false;
          // create a new FileNode with the currentFileNode as parent and add it to the currentFileNode children
          const newFileNode = FileNode.create(fileOrFolderPath, currentFileNode, this.ooxmlFilePath);
          currentFileNode = newFileNode;
        }
      }

      // cache or update the cache of the node and mark the status of the node

      // If the file node already exists and it isn't already marked as deleted,
      // the next state of the node can either
      // - "modified" if the file has been changed from the outside (handled in this if block)
      // - "unchanged" if the file has not been changed from the outside (handled in this if block)
      // - "deleted" if the file isn't included in the new ooxml package (handled in handleDeletedParts())
      // If the file node does not already exist, the only possible next state is "created" (handled in else block)
      // If the file node exists and is marked as deleted already, the next possible states are
      // - no node if the file isn't included in the new ooxml package (handled in handleDeletedParts())
      // - "created" if the file is recreated (handled in the else block)

      if (fileNodeAlreadyExists && !currentFileNode.isDeleted()) {
        const filesAreDifferent = await this.hasFileBeenChangedFromOutside(currentFileNode.nodePath, file.data);
        await this.cache.updateCachedFiles(currentFileNode.nodePath, file.data);

        if (filesAreDifferent) {
          currentFileNode.setModified();
        } else {
          currentFileNode.setUnchanged();
        }
      } else {
        if (!this.isFirstOpen) {
          await this.cache.createCachedFilesWithEmptyCompare(currentFileNode.nodePath, file.data);
          currentFileNode.setCreated();
        } else {
          await this.cache.createCachedFiles(currentFileNode.nodePath, file.data);
        }
      }
    }

    // need to handle deleted parts separately since the zip
    // doesn't contain them anymore
    await this.handleDeletedParts(fileContents.map(file => file.filePath));
    await this.reformatOpenTabs(fileContents.map(file => file.filePath));

    // tell vscode the tree has changed
    this.treeView.refresh();

    this.isFirstOpen = false;

    // Pre-warm the search snapshot for any parts the user has searched in
    // this session. This path runs when populate fired for a real external
    // change (we suppress it for our own self-writes — see
    // updateOOXMLFile + the watcher).
    this.prewarmSearchCache();
  }

  private prewarmSearchCache(): void {
    if (this.searchPartCache.size === 0) {
      return;
    }
    const paths = Array.from(this.searchPartCache.keys());
    Promise.all(paths.map(p => this.gatherOneSearchPart(p))).then(
      results => {
        // Push the fresh snapshot into the active search view so results
        // auto-update without requiring the user to re-type the term.
        const parts = results.filter(r => r.part).map(r => r.part as PartInput);
        const oversized = results.filter(r => r.oversized).map(r => r.path);
        this.activeSearchProvider?.notifySnapshotRefreshed(parts, oversized);
      },
      err => logger.error(`Search-cache prewarm failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /**
   * Traverse tree and delete cached parts that don't exist anymore.
   * If the file node is marked as deleted, delete the cached part, if it isn't, then
   * mark the node for deletion on next update.
   *
   * @param {string[]} filePaths The file paths in the ooxml file.
   */
  private async handleDeletedParts(filePaths: string[]): Promise<void> {
    const filesInOOXMLFile = new Set(filePaths);
    const fileNodeQueue = [this.treeView.getRootFileNode()];

    let fileNode;
    while ((fileNode = fileNodeQueue.pop())) {
      if (fileNode.isFile() && !filesInOOXMLFile.has(fileNode.nodePath)) {
        if (!fileNode.isDeleted()) {
          fileNode.setDeleted();
          await this.cache.updateCachedFiles(fileNode.nodePath, new Uint8Array());
        } else {
          // remove files marked as deleted from tree view and cache after the ooxml file
          // the second time the ooxml file is saved
          await this.cache.deleteCachedFiles(fileNode.nodePath);
          fileNode.parent?.children.splice(fileNode.parent.children.indexOf(fileNode), 1);
        }
      }

      fileNodeQueue.push(...fileNode.children);
    }

    this.treeView.refresh();
  }

  /**
   * Reformats the open tabs after their contents have been updated.
   * (Formats the xml of all tabs and closes the ones that were deleted)
   *
   * @param {string[]} filePaths The file paths in the ooxml file.
   */
  private async reformatOpenTabs(filePaths: string[]): Promise<void> {
    logger.debug('Reformatting open tabs');
    const filePathsInOOXMLPackage = new Set(filePaths);
    const openTextDocumentsInCache = ExtensionUtilities.getOpenTextDocumentFilePaths()
      .filter(fileName => this.cache.pathBelongsToCache(fileName))
      .map(fileName => this.cache.getFilePathFromCacheFilePath(fileName));

    const formatCacheDocuments = openTextDocumentsInCache
      .filter(p => filePathsInOOXMLPackage.has(p))
      .map(filePath => this.formatXml(filePath));

    const closeDocumentsInCacheButNotPackage = openTextDocumentsInCache
      .filter(fileName => !filePathsInOOXMLPackage.has(fileName))
      .map(fileName => ExtensionUtilities.closeTextDocument(fileName));

    await Promise.all([...formatCacheDocuments, ...closeDocumentsInCacheButNotPackage]);
  }

  /**
   * Collects the file paths that are eligible for document text search.
   *
   * @returns Sorted list of part paths (document.xml first, others alphabetical).
   */
  private getSearchableParts(): string[] {
    const result: string[] = [];
    const stack: FileNode[] = [...this.treeView.getRootFileNode().children];
    while (stack.length) {
      const node = stack.pop() as FileNode;
      if (node.isFile()) {
        if (SEARCHABLE_PART_PATTERN.test(node.nodePath) && !node.isDeleted()) {
          result.push(node.nodePath);
        }
      } else {
        stack.push(...node.children);
      }
    }
    result.sort((a, b) => {
      if (a === 'word/document.xml') return -1;
      if (b === 'word/document.xml') return 1;
      return a.localeCompare(b);
    });
    return result;
  }

  /**
   * Formats the candidate parts and decodes their formatted bytes into
   * `PartInput`s. Used both for the initial search invocation and for the
   * per-query refresh in the search view.
   *
   * Cheap path: stat the cache file; if `(mtime, size)` matches the cached
   * snapshot for this path, reuse the existing `PartInput` and skip the
   * format + decode entirely.
   *
   * Expensive path (file changed or never seen): run `formatXmlForSearch`,
   * read the formatted bytes, decode, and update the cache.
   *
   * @param {string[]} candidatePaths The part paths to format and read.
   */
  private async gatherSearchParts(candidatePaths: string[]): Promise<{ parts: PartInput[]; oversized: string[] }> {
    const results = await Promise.all(
      candidatePaths.map(async path => this.gatherOneSearchPart(path)),
    );
    const parts: PartInput[] = [];
    const oversized: string[] = [];
    for (const r of results) {
      if (r.oversized) {
        oversized.push(r.path);
      } else if (r.part) {
        parts.push(r.part);
      }
    }
    return { parts, oversized };
  }

  private gatherOneSearchPart(path: string): Promise<{ path: string; part?: PartInput; oversized: boolean }> {
    // Coalesce concurrent gathers for the same path so a duplicate query +
    // a background pre-warm don't both pay the format cost. The first
    // caller starts the work; concurrent callers await the same promise.
    const inFlight = this.inFlightGather.get(path);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.gatherOneSearchPartInner(path).finally(() => {
      this.inFlightGather.delete(path);
    });
    this.inFlightGather.set(path, promise);
    return promise;
  }

  private async gatherOneSearchPartInner(path: string): Promise<{ path: string; part?: PartInput; oversized: boolean }> {
    const cacheFilePath = this.cache.getNormalFileCachePath(path);
    const stat = await FileSystemUtilities.getStat(cacheFilePath);

    // Check the cache before doing any expensive work.
    const cached = this.searchPartCache.get(path);
    if (cached && stat && cached.mtime === stat.mtime && cached.size === stat.size) {
      return { path, part: cached.part, oversized: cached.oversized };
    }

    // File changed (or first time we've seen it) — re-format + re-read.
    const isOversized = await this.formatXmlForSearch(path);
    if (isOversized) {
      const oversizedStat = await FileSystemUtilities.getStat(cacheFilePath);
      if (oversizedStat) {
        this.searchPartCache.set(path, { mtime: oversizedStat.mtime, size: oversizedStat.size, oversized: true });
      }
      return { path, oversized: true };
    }

    const data = await this.cache.getCachedNormalFile(path);
    const part: PartInput = {
      partPath: path,
      cacheFilePath,
      xml: textDecoder.decode(data),
    };
    // Re-stat after format because format() may have written a new mtime.
    const finalStat = await FileSystemUtilities.getStat(cacheFilePath);
    if (finalStat) {
      this.searchPartCache.set(path, { mtime: finalStat.mtime, size: finalStat.size, oversized: false, part });
    }
    return { path, part, oversized: false };
  }

  /**
   * Inspects a cached part and returns whether it is XML and whether its
   * minified size exceeds the configured per-part formatting limit.
   * Both `formatXml` (diff/view path) and `formatXmlForSearch` (search path)
   * go through this helper so they cannot drift on what counts as "skip".
   *
   * @param {string} filePath The path of the file in the ooxml package.
   */
  private async getFormatPrecheck(
    filePath: string,
  ): Promise<{ isXml: boolean; oversized: boolean; size: number; data: Uint8Array }> {
    const data = await this.cache.getCachedNormalFile(filePath);
    const isXml = XmlFormatter.isXml(data);
    if (!isXml) {
      return { isXml: false, oversized: false, size: data.byteLength, data };
    }
    const size = XmlFormatter.minify(data, true).byteLength;
    return {
      isXml: true,
      oversized: size > this.extensionSettings.maximumXmlPartsFileSizeBytes,
      size,
      data,
    };
  }

  /**
   * Formats a part for search, returning whether the part was skipped because
   * it exceeds the maximum xml part size. Unlike `formatXml`, this does not
   * surface a warning for oversized parts — the orchestrator collects all
   * skipped parts and shows a single consolidated warning.
   *
   * @param {string} filePath The path of the file in the ooxml package.
   */
  private async formatXmlForSearch(filePath: string): Promise<boolean> {
    const precheck = await this.getFormatPrecheck(filePath);
    if (!precheck.isXml) {
      return false;
    }
    if (precheck.oversized) {
      return true;
    }
    const formatted = XmlFormatter.format(precheck.data);
    // `formatted !== precheck.data` is a fast-path: format() returns the
    // SAME reference only on the not-xml / format-failure paths, so a fresh
    // reference doesn't actually mean the bytes changed. Without the byte
    // compare, every refresh would write a byte-identical file, bump mtime,
    // and defeat the snapshot cache — turning every keystroke into a full
    // re-format pass for every part.
    if (formatted !== precheck.data && !buffersEqual(precheck.data, formatted)) {
      await this.cache.updateCachedFilesNoCompare(filePath, formatted);
    }
    return false;
  }

  /**
   * Tries to format the file as xml and if successful, updates the cached files.
   *
   * @param {string} filePath The path of the file in the ooxml package.
   */
  private async formatXml(filePath: string): Promise<void> {
    logger.debug(`Formatting '${filePath}'`);
    const precheck = await this.getFormatPrecheck(filePath);
    if (precheck.oversized) {
      if (precheck.isXml) {
        ExtensionUtilities.showWarning(
          `'${basename(filePath)}' size of '${precheck.size}' exceeds maximum of '${this.extensionSettings.maximumXmlPartsFileSizeBytes}' bytes`,
        );
      }
      return;
    }

    // Need to format the normal/prev and the compare separately for the diff to work
    const formatNormalXml = async () => {
      const fileContent = await this.cache.getCachedNormalFile(filePath);
      const formattedXml = XmlFormatter.format(fileContent);

      if (fileContent != formattedXml) {
        await this.cache.updateCachedFilesNoCompare(filePath, formattedXml);
      }
    };

    const formatCompareXml = async () => {
      const compareFileContent = await this.cache.getCachedCompareFile(filePath);
      const formattedXml = XmlFormatter.format(compareFileContent);

      if (compareFileContent != formattedXml) {
        await this.cache.updateCompareFile(filePath, formattedXml);
      }
    };

    await Promise.all([formatNormalXml(), formatCompareXml()]);
  }

  /**
   * Check if an OOXML part is different from its cached version.
   *
   * @param {string} filePath The path of the file in the ooxml package.
   * @param {string} newContent The updated contents of the file.
   * @returns {Promise<boolean>} A Promise resolving to whether or not the file has been changed from the outside.
   */
  private async hasFileBeenChangedFromOutside(filePath: string, newContent: Uint8Array): Promise<boolean> {
    const prevFileContent = await this.cache.getCachedPrevFile(filePath);

    return !XmlFormatter.areEqual(newContent, prevFileContent);
  }
}
