import { TextDocumentPositionParams } from "vscode-languageserver/node";

export default function getClickableFilePosition(
    textDocumentPositionParams: TextDocumentPositionParams
): string {
    return `${textDocumentPositionParams.textDocument.uri.replace("file://", "")}:${
        textDocumentPositionParams.position.line
    }:${textDocumentPositionParams.position.character}`;
}
