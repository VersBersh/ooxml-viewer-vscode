import { commands, ExtensionContext, Uri, window } from 'vscode';
import { OOXMLViewer } from './ooxml-viewer';
import { DocumentSearchViewProvider } from './search-view/document-search-view-provider';
import { FileNode, OOXMLTreeDataProvider } from './tree-view/ooxml-tree-view-provider';

import packageJson from '../package.json';
import { getExtensionSettings } from './ooxml-extension-settings';
import logger from './utilities/logger';

const extensionName = packageJson.displayName;

let ooxmlViewer: OOXMLViewer;

export async function activate(context: ExtensionContext): Promise<void> {
  const treeDataProvider = new OOXMLTreeDataProvider();
  const treeView = window.createTreeView('ooxmlViewer', { treeDataProvider: treeDataProvider });
  treeView.title = extensionName;

  const settings = getExtensionSettings();
  logger.info(`Starting '${extensionName}': ${JSON.stringify(settings, null, 4)}`);

  ooxmlViewer = new OOXMLViewer(treeDataProvider, settings, context);
  await ooxmlViewer.reset();

  const searchProvider = new DocumentSearchViewProvider(context.extensionUri);
  ooxmlViewer.setSearchProvider(searchProvider);

  context.subscriptions.push(
    treeView,

    window.registerTreeDataProvider('ooxmlViewer', treeDataProvider),
    window.registerWebviewViewProvider(DocumentSearchViewProvider.viewId, searchProvider),
    commands.registerCommand('ooxmlViewer.openOoxmlPackage', (file: Uri) => ooxmlViewer.openOOXMLPackage(file.fsPath)),
    commands.registerCommand('ooxmlViewer.removeOoxmlPackage', (fileNode: FileNode) =>
      ooxmlViewer.removeOOXMLPackage(fileNode.ooxmlPackagePath),
    ),
    commands.registerCommand('ooxmlViewer.viewFile', (fileNode: FileNode) =>
      ooxmlViewer.viewFile(fileNode.ooxmlPackagePath, fileNode.nodePath),
    ),
    commands.registerCommand('ooxmlViewer.clear', () => ooxmlViewer.reset()),
    commands.registerCommand('ooxmlViewer.showDiff', (fileNode: FileNode) =>
      ooxmlViewer.getDiff(fileNode.ooxmlPackagePath, fileNode.nodePath),
    ),
    commands.registerCommand('ooxmlViewer.searchParts', (fileNode: FileNode) => ooxmlViewer.searchOOXMLParts(fileNode.ooxmlPackagePath)),
    commands.registerCommand('ooxmlViewer.searchDocumentText', (fileNode: FileNode) => {
      const filePath = fileNode.isFile() ? fileNode.nodePath : undefined;
      return ooxmlViewer.searchDocumentText(fileNode.ooxmlPackagePath, filePath);
    }),
    commands.registerCommand('ooxmlViewer.closeDocumentSearch', () => searchProvider.close()),
    commands.registerCommand('ooxmlViewer.refreshDocumentSearch', () => searchProvider.manualRefresh()),
  );
}

export async function deactivate(): Promise<void> {
  logger.info(`Deactivating '${extensionName}'`);
  await ooxmlViewer?.reset();
}
