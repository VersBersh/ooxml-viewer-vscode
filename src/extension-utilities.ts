import { FileSystemError, Position, Range, TextEditor, TextEditorEdit, window } from 'vscode';

export class ExtensionUtilities {
  /**
   * @description Make a text editor tab dirty.
   * @method makeTextEditorDirty
   * @async
   * @param {TextEditor} activeTextEditor the text editor to be made dirty.
   * @returns {Promise<void>}
   */
  static async makeTextEditorDirty(activeTextEditor?: TextEditor): Promise<void> {
    activeTextEditor?.edit(async (textEditorEdit: TextEditorEdit) => {
      if (window.activeTextEditor?.selection) {
        const { activeTextEditor } = window;

        if (activeTextEditor && activeTextEditor.document.lineCount >= 2) {
          const lineNumber = activeTextEditor.document.lineCount - 2;
          const lastLineRange = new Range(new Position(lineNumber, 0), new Position(lineNumber + 1, 0));
          const lastLineText = activeTextEditor.document.getText(lastLineRange);
          textEditorEdit.replace(lastLineRange, lastLineText);
          return;
        }

        // Try to replace the first character.
        const range = new Range(new Position(0, 0), new Position(0, 1));
        const text: string | undefined = activeTextEditor?.document.getText(range);
        if (text) {
          textEditorEdit.replace(range, text);
          return;
        }

        // With an empty file, we first add a character and then remove it.
        // This has to be done as two edits, which can cause the cursor to
        // visibly move and then return, but we can at least combine them
        // into a single undo step.
        await activeTextEditor?.edit(
          (innerEditBuilder: TextEditorEdit) => {
            innerEditBuilder.replace(range, ' ');
          },
          { undoStopBefore: true, undoStopAfter: false },
        );

        await activeTextEditor?.edit(
          (innerEditBuilder: TextEditorEdit) => {
            innerEditBuilder.replace(range, '');
          },
          { undoStopBefore: false, undoStopAfter: true },
        );
      }
    });
  }

  static async handleError(err: unknown): Promise<void> {
    try {
      let msg = 'unknown error';

      if (typeof err === 'string') {
        msg = err;
      } else if (err instanceof Error) {
        msg = err.message;
      }

      await window.showErrorMessage(msg);
    } catch (error) {
      const msg = (error as Error)?.message || (error as FileSystemError)?.code || 'unknown error';
      throw new Error(msg);
    }
  }
}
