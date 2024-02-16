/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
    createConnection,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    DocumentSymbol,
    SymbolKind,
    HoverParams,
    TypeDefinitionParams,
} from "vscode-languageserver/node";
import { InlayHintParams } from "vscode-languageserver-protocol";
import { fileURLToPath } from "node:url";

import { JaktSymbol, JaktTextDocument } from "./types";
import convertSpan from "./utils/convertSpan";
import findLineBreaks from "./utils/findLineBreaks";
import includeFlagForPath from "./utils/includeFlagForPath";
import logDuration from "./utils/logDuration";
import convertPositionToIndex from "./utils/convertPositionToIndex";
import runCompiler from "./utils/runCompiler";
import clickableFilePosition from "./utils/clickableFilePosition";
import goToDefinition from "./utils/goToDefinition";
import { capabilities } from "./capabilities";
import { getDocumentManager } from "./documents";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);
const documentsManager = getDocumentManager(connection);

connection.onInitialize((params: InitializeParams) => {
    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    capabilities.hasConfigurationCapability = !!(
        params.capabilities.workspace && !!params.capabilities.workspace.configuration
    );
    capabilities.hasWorkspaceFolderCapability = !!(
        params.capabilities.workspace && !!params.capabilities.workspace.workspaceFolders
    );
    capabilities.hasDiagnosticRelatedInformationCapability = !!(
        params.capabilities.textDocument &&
        params.capabilities.textDocument.publishDiagnostics &&
        params.capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // Tell the client that this server doesn't support code completion. (yet)
            completionProvider: {
                resolveProvider: false,
                triggerCharacters: ["."],
            },
            inlayHintProvider: {
                resolveProvider: false,
            },
            definitionProvider: true,
            typeDefinitionProvider: true,
            documentSymbolProvider: true,
            hoverProvider: true,
            documentFormattingProvider: true,
            documentRangeFormattingProvider: true,
        },
    };
    if (capabilities.hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true,
            },
        };
    }

    return result;
});

connection.onInitialized(() => {
    if (capabilities.hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
});

connection.onDocumentSymbol(async (request): Promise<DocumentSymbol[]> => {
    return await logDuration(`onDocumentSymbol`, async () => {
        const documentAndSettings = await documentsManager.get(request.textDocument.uri);
        if (!documentAndSettings) return [];
        const { document, settings } = documentAndSettings;

        const text = document.getText();
        const lineBreaks = findLineBreaks(text);
        const stdout = await runCompiler(
            connection,
            text,
            "--print-symbols " + includeFlagForPath(request.textDocument.uri),
            settings,
            {},
            fileURLToPath(document.uri)
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
        const result = (JSON.parse(stdout) as JaktSymbol[]).map(symbol =>
            toSymbolDefinition(symbol)
        );
        return result;
    });
});

connection.onDefinition(async request => {
    return await logDuration(`onDefinition ${clickableFilePosition(request)}`, async () => {
        const documentAndSettings = await documentsManager.get(request.textDocument.uri);
        if (!documentAndSettings) return;
        const { document, settings } = documentAndSettings;

        const text = document.getText();

        const stdout = await runCompiler(
            connection,
            text,
            "-g " +
                convertPositionToIndex(request.position, text) +
                includeFlagForPath(request.textDocument.uri),
            settings,
            {},
            fileURLToPath(document.uri)
        );
        return goToDefinition(document, stdout);
    });
});

connection.onTypeDefinition(async (request: TypeDefinitionParams) => {
    return await logDuration(`onTypeDefinition ${clickableFilePosition(request)}`, async () => {
        const documentAndSettings = await documentsManager.get(request.textDocument.uri);
        if (!documentAndSettings) return;
        const { document, settings } = documentAndSettings;

        const text = document.getText();
        const stdout = await runCompiler(
            connection,
            text,
            "-t " +
                convertPositionToIndex(request.position, text) +
                includeFlagForPath(request.textDocument.uri),
            settings,
            {},
            fileURLToPath(document.uri)
        );
        return goToDefinition(document, stdout);
    });
});

connection.onHover(async (request: HoverParams) => {
    return await logDuration(`onHover ${clickableFilePosition(request)}`, async () => {
        const documentAndSettings = await documentsManager.get(request.textDocument.uri);
        if (!documentAndSettings) return;
        const { document, settings } = documentAndSettings;

        const text = document.getText();

        if (!(typeof text == "string")) return null;

        const stdout = await runCompiler(
            connection,
            text,
            "-e " +
                convertPositionToIndex(request.position, text) +
                includeFlagForPath(request.textDocument.uri),
            settings,
            {},
            document ? fileURLToPath(document.uri) : undefined
        );

        const lines = stdout.split("\n").filter(l => l.length > 0);
        for (const line of lines) {
            const obj = JSON.parse(line);

            // FIXME: Figure out how to import `vscode` package in server.ts without
            // getting runtime import errors to remove this deprication warning.
            const contents = {
                value: obj.hover,
                language: "jakt",
            };

            if (obj.hover != "") {
                return { contents };
            }
        }
    });
});

connection.onDidChangeConfiguration(change => documentsManager.onDidChangeConfiguration(change));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
connection.onDidChangeWatchedFiles(_change => {
    // Monitored files have change in VSCode
    connection.console.log("We received an file change event");
});

// This handler provides the initial list of the completion items.
connection.onCompletion(async (request: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    return await logDuration(`onCompletion ${clickableFilePosition(request)}`, async () => {
        // The pass parameter contains the position of the text document in
        // which code complete got requested. For the example we ignore this
        // info and always provide the same completion items.

        const documentAndSettings = await documentsManager.get(request.textDocument.uri);
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
});

connection.onDocumentFormatting(async params => {
    return await logDuration(`onDocumentFormatting`, async () => {
        const documentAndSettings = await documentsManager.get(params.textDocument.uri);
        if (!documentAndSettings) return [];
        const { document, settings } = documentAndSettings;

        const text = document.getText();

        if (typeof text == "string") {
            const stdout = await runCompiler(
                connection,
                text,
                "-f " + includeFlagForPath(params.textDocument.uri),
                settings,
                { allowErrors: false },
                fileURLToPath(document.uri)
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
});

connection.onDocumentRangeFormatting(async params => {
    return await logDuration(`onDocumentRangeFormatting`, async () => {
        const documentAndSettings = await documentsManager.get(params.textDocument.uri);
        if (!documentAndSettings) return [];
        const { document, settings } = documentAndSettings;

        const text = document.getText();

        if (typeof text == "string") {
            const stdout = await runCompiler(
                connection,
                text,
                `--format-range ${convertPositionToIndex(
                    params.range.start,
                    text
                )}:${convertPositionToIndex(params.range.end, text)} -f ${includeFlagForPath(
                    params.textDocument.uri
                )}`,
                settings,
                { allowErrors: false },
                document ? fileURLToPath(document.uri) : undefined
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
});

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    if (item.data === 1) {
        item.detail = "TypeScript details";
        item.documentation = "TypeScript documentation";
    } else if (item.data === 2) {
        item.detail = "JavaScript details";
        item.documentation = "JavaScript documentation";
    }
    return item;
});

connection.languages.inlayHint.on(async (params: InlayHintParams) => {
    const documentAndSettings = await documentsManager.get(params.textDocument.uri);
    if (!documentAndSettings) return [];
    return (documentAndSettings.document as JaktTextDocument).jaktInlayHints;
});

// Listen on the connection
connection.listen();
