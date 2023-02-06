import { commands, ExtensionContext, Uri, window } from 'vscode';
import { FileNode } from './ooxml-tree-view-provider';
import { OOXMLViewer } from './ooxml-viewer';
import * as rx from './rapid-xml-formatter';

let ooxmlViewer: OOXMLViewer;

export async function activate(context: ExtensionContext): Promise<void> {
  ooxmlViewer = new OOXMLViewer(context);
  await ooxmlViewer.clear();

  context.subscriptions.push(
    window.registerTreeDataProvider('ooxmlViewer', ooxmlViewer.treeDataProvider),
    commands.registerCommand('ooxmlViewer.openOoxmlPackage', async (file: Uri) => ooxmlViewer.openOoxmlPackage(file)),
    commands.registerCommand('ooxmlViewer.viewFile', async (fileNode: FileNode) => ooxmlViewer.viewFile(fileNode)),
    commands.registerCommand('ooxmlViewer.clear', () => ooxmlViewer.clear()),
    commands.registerCommand('ooxmlViewer.showDiff', async (file: FileNode) => ooxmlViewer.getDiff(file)),
    commands.registerCommand('ooxmlViewer.searchParts', async () => ooxmlViewer.searchOoxmlParts()),
  );

  rx.Load(context.extensionPath);
}

export async function deactivate(): Promise<void> {
  ooxmlViewer?.disposeWatchers();
}
