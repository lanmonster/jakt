import {
    Connection,
    DocumentSymbol,
    DocumentSymbolParams,
    SymbolKind,
} from "vscode-languageserver";
import { JaktSymbol } from "../types";
import convertSpan from "../utils/convertSpan";
import findLineBreaks from "../utils/findLineBreaks";
import includeFlagForPath from "../utils/includeFlagForPath";
import logDuration from "../utils/logDuration";
import runCompiler from "../utils/runCompiler";
import { getDocumentManager } from "../documents";

import { fileURLToPath } from "node:url";

type DocumentSymbolHandler = (params: DocumentSymbolParams) => Promise<DocumentSymbol[]>;
export function handleDocumentSymbol(connection: Connection): DocumentSymbolHandler {
    return async ({ textDocument }) =>
        await logDuration(`onDocumentSymbol`, async () => {
            const documentAndSettings = await getDocumentManager(connection).get(textDocument.uri);
            if (!documentAndSettings) return [];
            const { document, settings } = documentAndSettings;

            const text = document.getText();
            const lineBreaks = findLineBreaks(text);
            const stdout = await runCompiler(
                connection,
                text,
                {
                    "--print-symbols": true,
                    "-I": includeFlagForPath(textDocument.uri),
                    "--assume-main-file-path": fileURLToPath(document.uri),
                },
                settings
            );
            const toSymbolDefinition = (symbol: JaktSymbol): DocumentSymbol => {
                const kind_map = {
                    namespace: SymbolKind.Namespace,
                    function: SymbolKind.Function,
                    method: SymbolKind.Method,
                    struct: SymbolKind.Struct,
                    class: SymbolKind.Class,
                    enum: SymbolKind.Enum,
                    "enum-member": SymbolKind.EnumMember,
                };
                return {
                    name: symbol.name,
                    detail: symbol.detail,
                    kind: kind_map[symbol.kind],
                    range: {
                        start: convertSpan(symbol.range.start, lineBreaks),
                        end: convertSpan(symbol.range.end, lineBreaks),
                    },
                    selectionRange: {
                        start: convertSpan(symbol.selection_range.start, lineBreaks),
                        end: convertSpan(symbol.selection_range.end, lineBreaks),
                    },
                    children: symbol.children.map(child => toSymbolDefinition(child)),
                };
            };
            return (JSON.parse(stdout) as JaktSymbol[]).map(toSymbolDefinition);
        });
}
