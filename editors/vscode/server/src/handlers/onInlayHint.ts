import { Connection, InlayHintParams } from "vscode-languageserver";
import { getDocumentManager } from "../documents";
import { JaktTextDocument } from "../types";

export function handleInlayHint(connection: Connection) {
    return async (params: InlayHintParams) => {
        const documentAndSettings = await getDocumentManager(connection).get(
            params.textDocument.uri
        );
        if (!documentAndSettings) return [];
        return (documentAndSettings.document as JaktTextDocument).jaktInlayHints;
    };
}
