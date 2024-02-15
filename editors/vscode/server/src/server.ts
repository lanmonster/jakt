/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
    createConnection,
    TextDocuments,
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

import { JaktSymbol, JaktTextDocument, Settings } from "./types";
import convertSpan from "./utils/convertSpan";
import throttle from "./utils/throttle";
import findLineBreaks from "./utils/findLineBreaks";
import includeFlagForPath from "./utils/includeFlagForPath";
import logDuration from "./utils/logDuration";
import convertPositionToIndex from "./utils/convertPositionToIndex";
import runCompiler from "./utils/runCompiler";
import clickableFilePosition from "./utils/clickableFilePosition";
import { validateTextDocument } from "./utils/validateTextDocument";
import goToDefinition from "./utils/goToDefinition";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
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
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true,
            },
        };
    }

    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
});

connection.onDocumentSymbol(async (request): Promise<DocumentSymbol[]> => {
    return await logDuration(`onDocumentSymbol`, async () => {
        const settings = await getDocumentSettings(request.textDocument.uri);
        const document = documents.get(request.textDocument.uri);
        if (!document) return [];

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
        const document = documents.get(request.textDocument.uri);
        if (!document) return;
        const settings = await getDocumentSettings(request.textDocument.uri);

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
        const document = documents.get(request.textDocument.uri);
        if (!document) return;
        const settings = await getDocumentSettings(request.textDocument.uri);

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
        const document = documents.get(request.textDocument.uri);
        const settings = await getDocumentSettings(request.textDocument.uri);

        const text = document?.getText();

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

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: Settings = {
    maxNumberOfProblems: 1000,
    maxCompilerInvocationTime: 5000,
    extraCompilerImportPaths: [],
    compiler: { executablePath: "jakt" },
    hints: { showImplicitTry: true, showInferredTypes: true },
};

let globalSettings: Settings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<Settings>> = new Map();

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        globalSettings = <Settings>(change.settings.jaktLanguageServer || defaultSettings);
    }

    // Revalidate all open text documents
    documents
        .all()
        .forEach(async document =>
            validateTextDocument(connection, document, await getDocumentSettings(document.uri))
        );
});

function getDocumentSettings(resource: string): Thenable<Settings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: "jaktLanguageServer",
        });
        documentSettings.set(resource, result);
    }
    return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(
    (() => {
        const throttledValidateTextDocument = throttle(validateTextDocument, 500);
        return async change => {
            throttledValidateTextDocument(
                connection,
                change.document,
                await getDocumentSettings(change.document.uri)
            );
        };
    })()
);

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

        const document = documents.get(request.textDocument.uri);
        const settings = await getDocumentSettings(request.textDocument.uri);

        const text = document?.getText();

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
        const document = documents.get(params.textDocument.uri);
        const settings = await getDocumentSettings(params.textDocument.uri);

        if (document === undefined) return [];

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
        const document = documents.get(params.textDocument.uri);
        const settings = await getDocumentSettings(params.textDocument.uri);

        const text = document?.getText();

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

connection.languages.inlayHint.on((params: InlayHintParams) => {
    const document = documents.get(params.textDocument.uri) as JaktTextDocument;
    return document.jaktInlayHints;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
