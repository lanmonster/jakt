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
    InlayHintParams,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { JaktSymbol, JaktTextDocument, Settings } from "./types";
import { capabilities } from "./capabilities";
import { fileURLToPath } from "url";
import includeFlagForPath from "./utils/includeFlagForPath";
import getClickableFilePosition from "./utils/getClickableFilePosition";
import durationLogWrapper from "./utils/durationLogWrapper";
import throttle from "./utils/throttle";
import convertSpan from "./utils/convertSpan";
import convertPosition from "./utils/convertPosition";
import findLineBreaks from "./utils/findLineBreaks";
import goToDefinition from "./utils/goToDefinition";
import runCompiler from "./utils/runCompiler";
import validateTextDocument from "./utils/validateTextDocument";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

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
    return await durationLogWrapper(`onDocumentSymbol`, async () => {
        const settings = await getDocumentSettings(request.textDocument.uri);
        const document = documents.get(request.textDocument.uri);
        if (!document) return [];

        const text = document.getText();
        const lineBreaks = findLineBreaks(text);
        const stdout = await runCompiler(
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
    return await durationLogWrapper(
        `onDefinition ${getClickableFilePosition(request)}`,
        async () => {
            const document = documents.get(request.textDocument.uri);
            if (!document) return;
            const settings = await getDocumentSettings(request.textDocument.uri);

            const text = document.getText();

            const stdout = await runCompiler(
                text,
                "-g " +
                    convertPosition(request.position, text) +
                    includeFlagForPath(request.textDocument.uri),
                settings,
                {},
                fileURLToPath(document.uri)
            );
            return goToDefinition(document, stdout);
        }
    );
});

connection.onTypeDefinition(async (request: TypeDefinitionParams) => {
    return await durationLogWrapper(
        `onTypeDefinition ${getClickableFilePosition(request)}`,
        async () => {
            const document = documents.get(request.textDocument.uri);
            if (!document) return;
            const settings = await getDocumentSettings(request.textDocument.uri);

            const text = document.getText();
            const stdout = await runCompiler(
                text,
                "-t " +
                    convertPosition(request.position, text) +
                    includeFlagForPath(request.textDocument.uri),
                settings,
                {},
                fileURLToPath(document.uri)
            );
            return goToDefinition(document, stdout);
        }
    );
});

connection.onHover(async (request: HoverParams) => {
    return await durationLogWrapper(`onHover ${getClickableFilePosition(request)}`, async () => {
        const document = documents.get(request.textDocument.uri);
        const settings = await getDocumentSettings(request.textDocument.uri);

        const text = document?.getText();

        if (!(typeof text == "string")) return null;

        const stdout = await runCompiler(
            text,
            "-e " +
                convertPosition(request.position, text) +
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
    if (capabilities.hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        globalSettings = <Settings>(change.settings.jaktLanguageServer || defaultSettings);
    }

    // Revalidate all open text documents
    documents.all().forEach(document => {
        getDocumentSettings(document.uri).then(settings =>
            throttledValidateTextDocument(connection, document, settings)
        );
    });
});

function getDocumentSettings(resource: string): Thenable<Settings> {
    if (!capabilities.hasConfigurationCapability) {
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

const throttledValidateTextDocument = throttle(
    validateTextDocument,
    500
) as typeof validateTextDocument;

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    getDocumentSettings(change.document.uri).then(settings =>
        throttledValidateTextDocument(connection, change.document, settings)
    );
});

// This handler provides the initial list of the completion items.
connection.onCompletion(async (request: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    return await durationLogWrapper(
        `onCompletion ${getClickableFilePosition(request)}`,
        async () => {
            // The pass parameter contains the position of the text document in
            // which code complete got requested. For the example we ignore this
            // info and always provide the same completion items.

            const document = documents.get(request.textDocument.uri);
            const settings = await getDocumentSettings(request.textDocument.uri);

            const text = document?.getText();

            if (typeof text == "string") {
                const index = convertPosition(request.position, text) - 1;
                const stdout = await runCompiler(
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
        }
    );
});

connection.onDocumentFormatting(async params => {
    return await durationLogWrapper(`onDocumentFormatting`, async () => {
        const document = documents.get(params.textDocument.uri);
        const settings = await getDocumentSettings(params.textDocument.uri);

        if (document === undefined) return [];

        const text = document.getText();

        if (typeof text == "string") {
            const stdout = await runCompiler(
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
    return await durationLogWrapper(`onDocumentRangeFormatting`, async () => {
        const document = documents.get(params.textDocument.uri);
        const settings = await getDocumentSettings(params.textDocument.uri);

        const text = document?.getText();

        if (typeof text == "string") {
            const stdout = await runCompiler(
                text,
                `--format-range ${convertPosition(params.range.start, text)}:${convertPosition(
                    params.range.end,
                    text
                )} -f ${includeFlagForPath(params.textDocument.uri)}`,
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

connection.languages.inlayHint.on((params: InlayHintParams) => {
    const document = documents.get(params.textDocument.uri) as JaktTextDocument;
    return document.jaktInlayHints;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
