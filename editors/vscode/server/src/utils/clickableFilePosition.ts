import { TextDocumentPositionParams } from "vscode-languageserver/node";

export default function clickableFilePosition({
    textDocument,
    position,
}: TextDocumentPositionParams): string {
    return `${textDocument.uri.replace("file://", "")}:${position.line}:${position.character}`;
}
