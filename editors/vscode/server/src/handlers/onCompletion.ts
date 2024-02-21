import {
    CompletionItem,
    CompletionItemKind,
    Connection,
    TextDocumentPositionParams,
} from "vscode-languageserver";
import clickableFilePosition from "../utils/clickableFilePosition";
import convertPositionToIndex from "../utils/convertPositionToIndex";
import includeFlagForPath from "../utils/includeFlagForPath";
import logDuration from "../utils/logDuration";
import runCompiler from "../utils/runCompiler";

import { fileURLToPath } from "node:url";
import { getDocumentManager } from "../documents";

export function handleCompletion(connection: Connection) {
    return async (request: TextDocumentPositionParams): Promise<CompletionItem[]> =>
        await logDuration(`onCompletion ${clickableFilePosition(request)}`, async () => {
            // The pass parameter contains the position of the text document in
            // which code complete got requested. For the example we ignore this
            // info and always provide the same completion items.

            const documentAndSettings = await getDocumentManager(connection).get(
                request.textDocument.uri
            );
            if (!documentAndSettings) return [];
            const { document, settings } = documentAndSettings;

            const text = document.getText();

            if (typeof text == "string") {
                const index = convertPositionToIndex(request.position, text) - 1;
                const stdout = await runCompiler(
                    connection,
                    text,
                    "-m " + index + includeFlagForPath(request.textDocument.uri),
                    settings,
                    {},
                    document ? fileURLToPath(document.uri) : undefined
                );

                const lines = stdout.split("\n").filter(l => l.length > 0);
                for (const line of lines) {
                    const obj = JSON.parse(line);

                    const output = [];
                    let index = 1;
                    for (const completion of obj.completions) {
                        output.push({
                            label: completion,
                            kind: completion.includes("(")
                                ? CompletionItemKind.Function
                                : CompletionItemKind.Field,
                            data: index,
                        });
                        index++;
                    }
                    return output;
                }
            }

            return [];
        });
}
