import {
    Connection,
    DocumentFormattingParams,
    DocumentRangeFormattingParams,
    TextEdit,
} from "vscode-languageserver";
import includeFlagForPath from "../utils/includeFlagForPath";
import logDuration from "../utils/logDuration";
import runCompiler from "../utils/runCompiler";
import { getDocumentManager } from "../documents";

import { fileURLToPath } from "node:url";
import convertPositionToIndex from "../utils/convertPositionToIndex";

type DocumentFormatHandler<TParams> = (params: TParams) => Promise<TextEdit[]>;

export function handleDocumentFormat(
    connection: Connection
): DocumentFormatHandler<DocumentFormattingParams> {
    return async (params: DocumentFormattingParams) =>
        await logDuration(`onDocumentFormatting`, async () => {
            const documentAndSettings = await getDocumentManager(connection).get(
                params.textDocument.uri
            );
            if (!documentAndSettings) return [];
            const { document, settings } = documentAndSettings;

            const text = document.getText();

            if (typeof text == "string") {
                const stdout = await runCompiler(
                    connection,
                    text,
                    {
                        "-f": true,
                        "-I": includeFlagForPath(params.textDocument.uri),
                        "--assume-main-file-path": fileURLToPath(document.uri),
                    },
                    settings,
                    { allowErrors: false }
                );
                const formatted = stdout;
                return [
                    {
                        range: {
                            start: { line: 0, character: 0 },
                            end: { line: document.lineCount, character: 0 },
                        },
                        newText: formatted,
                    },
                ];
            }
            return [];
        });
}

export function handleDocumentRangeFormat(
    connection: Connection
): DocumentFormatHandler<DocumentRangeFormattingParams> {
    return async params =>
        await logDuration(`onDocumentRangeFormatting`, async () => {
            const documentAndSettings = await getDocumentManager(connection).get(
                params.textDocument.uri
            );
            if (!documentAndSettings) return [];
            const { document, settings } = documentAndSettings;

            const text = document.getText();

            if (typeof text == "string") {
                const stdout = await runCompiler(
                    connection,
                    text,
                    {
                        "--format-range": [
                            convertPositionToIndex(params.range.start, text),
                            convertPositionToIndex(params.range.end, text),
                        ],
                        "-f": true,
                        "-I": includeFlagForPath(params.textDocument.uri),
                        "--assume-main-file-path": fileURLToPath(document.uri),
                    },
                    settings,
                    { allowErrors: false }
                );
                const formatted = stdout;
                return [
                    {
                        range: params.range,
                        newText: formatted,
                    },
                ];
            }
            return [];
        });
}
