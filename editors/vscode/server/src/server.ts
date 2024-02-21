/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    HandlerResult,
    Definition,
    DocumentSymbol,
    SymbolKind,
    HoverParams,
    TypeDefinitionParams,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

import {
    Position,
    InlayHint,
    InlayHintParams,
    InlayHintLabelPart,
    InlayHintKind,
} from "vscode-languageserver-protocol";

import * as fs from "fs";
import * as tmp from "tmp";
import * as path from "path";

import { TextEncoder, promisify } from "node:util";
import { exec as execWithCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JaktSymbol, JaktTextDocument, Settings } from "./types";
import { capabilities } from "./capabilities";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

const exec = promisify(execWithCallback);

const tmpFile = tmp.fileSync();

function includeFlagForPath(file_path: string): string {
    if (file_path.startsWith("file://")) {
        file_path = decodeURI(file_path);
        return " -I " + path.dirname(fileURLToPath(file_path));
    }
    return " -I " + file_path;
}

function getClickableFilePosition(textDocumentPositionParams: TextDocumentPositionParams) {
    return `${textDocumentPositionParams.textDocument.uri.replace("file://", "")}:${
        textDocumentPositionParams.position.line
    }:${textDocumentPositionParams.position.character}`;
}

async function durationLogWrapper<T>(label: string, fn: () => Promise<T>): Promise<T> {
    console.log("Triggered " + label + ": ...");
    console.time(label);
    const result = await fn();

    // This purposefully has the same prefix length as the "Triggered " log above,
    // also does not add a newline at the end.
    process.stdout.write("Finished  ");
    console.timeEnd(label);
    return new Promise<T>(resolve => resolve(result));
}

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

async function goToDefinition(
    document: TextDocument,
    jaktOutput: string
): Promise<HandlerResult<Definition, void> | undefined> {
    return await durationLogWrapper(`goToDefinition`, async () => {
        const lines = jaktOutput.split("\n").filter(l => l.length > 0);
        for (const line of lines) {
            const obj = JSON.parse(line);
            if (obj.file === "" || obj.file === "__prelude__") return;

            const lineBreaks = findLineBreaks(
                obj.file
                    ? (await fs.promises.readFile(obj.file)).toString()
                    : document.getText() ?? ""
            );

            const uri = obj.file
                ? "file://" + (await fs.promises.realpath(obj.file))
                : document.uri;

            return {
                uri: uri,
                range: {
                    start: convertSpan(obj.start, lineBreaks),
                    end: convertSpan(obj.end, lineBreaks),
                },
            };
        }
    });
}

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
    documents.all().forEach(validateTextDocument);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function throttle(fn: (...args: any) => void, delay: number) {
    let shouldWait = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let waitingArgs: any | null;
    const timeoutFunc = () => {
        if (waitingArgs == null) {
            shouldWait = false;
        } else {
            fn(...waitingArgs);
            waitingArgs = null;
            setTimeout(timeoutFunc, delay);
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (...args: any) => {
        if (shouldWait) {
            waitingArgs = args;
            return;
        }

        fn(...args);
        shouldWait = true;

        setTimeout(timeoutFunc, delay);
    };
}

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(
    (() => {
        const throttledValidateTextDocument = throttle(validateTextDocument, 500);
        return change => {
            throttledValidateTextDocument(change.document);
        };
    })()
);

function lowerBoundBinarySearch(arr: number[], num: number): number {
    let low = 0;
    let mid = 0;
    let high = arr.length - 1;

    if (num >= arr[high]) return high;

    while (low < high) {
        // Bitshift to avoid floating point division
        mid = (low + high) >> 1;

        if (arr[mid] < num) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    return low - 1;
}

function convertSpan(utf8_offset: number, lineBreaks: Array<number>): Position {
    const lineBreakIndex = lowerBoundBinarySearch(lineBreaks, utf8_offset);

    const start_of_line_offset = lineBreakIndex == -1 ? 0 : lineBreaks[lineBreakIndex] + 1;
    const character = Math.max(0, utf8_offset - start_of_line_offset);

    return { line: lineBreakIndex + 1, character };
}

function convertPosition(position: Position, text: string): number {
    let line = 0;
    let character = 0;
    const buffer = new TextEncoder().encode(text);

    let i = 0;
    while (i < buffer.length) {
        if (line == position.line && character == position.character) {
            return i;
        }

        if (buffer.at(i) == 0x0a) {
            line++;
            character = 0;
        } else {
            character++;
        }

        i++;
    }

    return i;
}

async function runCompiler(
    text: string,
    flags: string,
    settings: Settings,
    options: { allowErrors?: boolean } = {},
    path?: string
): Promise<string> {
    const allowErrors = options.allowErrors === undefined ? true : options.allowErrors;

    try {
        fs.writeFileSync(tmpFile.name, text);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
        // connection.console.log(e);
    }

    const assume_main_file = path ? `--assume-main-file-path ${path}` : ``;
    const command = `${
        settings.compiler.executablePath
    } ${assume_main_file} ${flags} ${settings.extraCompilerImportPaths
        .map(x => "-I " + x)
        .join(" ")} ${tmpFile.name}`;

    console.info(`Running command: ${command}`);

    let stdout = "";
    try {
        const output = await exec(command, {
            timeout: settings.maxCompilerInvocationTime,
        });
        stdout = output.stdout;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
        stdout = e.stdout;
        if (!allowErrors) {
            if (e.signal != null) {
                connection.console.log("compile failed: ");
                connection.console.log(e);
            } else {
                connection.console.log("Error:" + e);
            }
            throw e;
        } else {
            console.error(e);
        }
    }

    return stdout;
}

function findLineBreaks(utf16_text: string): Array<number> {
    const utf8_text = new TextEncoder().encode(utf16_text);
    const lineBreaks: Array<number> = [];

    for (let i = 0; i < utf8_text.length; ++i) {
        if (utf8_text[i] == 0x0a) {
            lineBreaks.push(i);
        }
    }

    return lineBreaks;
}

async function validateTextDocument(textDocument: JaktTextDocument): Promise<void> {
    return await durationLogWrapper(`validateTextDocument ${textDocument.uri}`, async () => {
        if (!capabilities.hasDiagnosticRelatedInformationCapability) {
            console.error("Trying to validate a document with no diagnostic capability");
            return;
        }

        // // In this simple example we get the settings for every validate run.
        const settings = await getDocumentSettings(textDocument.uri);

        // The validator creates diagnostics for all uppercase words length 2 and more
        const text = textDocument.getText();

        const lineBreaks = findLineBreaks(text);

        const stdout = await runCompiler(
            text,
            "-c --type-hints --try-hints -j" + includeFlagForPath(textDocument.uri),
            settings,
            {},
            fileURLToPath(textDocument.uri)
        );

        textDocument.jaktInlayHints = [];

        const diagnostics: Diagnostic[] = [];

        // FIXME: We use this to deduplicate type hints given by the compiler.
        //        It'd be nicer if it didn't give duplicate hints in the first place.
        const seenTypeHintPositions = new Set();

        const lines = stdout.split("\n").filter(l => l.length > 0);
        for (const line of lines) {
            try {
                const obj = JSON.parse(line);

                // HACK: Ignore everything that isn't about file ID #1 here, since that's always the current editing buffer.
                if (obj.file_id != 1) {
                    continue;
                }
                if (obj.type == "diagnostic") {
                    let severity: DiagnosticSeverity = DiagnosticSeverity.Error;

                    switch (obj.severity) {
                        case "Information":
                            severity = DiagnosticSeverity.Information;
                            break;
                        case "Hint":
                            severity = DiagnosticSeverity.Hint;
                            break;
                        case "Warning":
                            severity = DiagnosticSeverity.Warning;
                            break;
                        case "Error":
                            severity = DiagnosticSeverity.Error;
                            break;
                    }

                    const position_start = convertSpan(obj.span.start, lineBreaks);
                    const position_end = convertSpan(obj.span.end, lineBreaks);

                    const diagnostic: Diagnostic = {
                        severity,
                        range: {
                            start: position_start,
                            end: position_end,
                        },
                        message: obj.message,
                        source: textDocument.uri,
                    };

                    diagnostics.push(diagnostic);
                } else if (obj.type == "hint" && settings.hints.showInferredTypes) {
                    if (!seenTypeHintPositions.has(obj.position)) {
                        seenTypeHintPositions.add(obj.position);
                        const position = convertSpan(obj.position, lineBreaks);
                        const hint_string = ": " + obj.typename;
                        const hint = InlayHint.create(
                            position,
                            [InlayHintLabelPart.create(hint_string)],
                            InlayHintKind.Type
                        );

                        textDocument.jaktInlayHints.push(hint);
                    }
                } else if (obj.type == "try" && settings.hints.showImplicitTry) {
                    if (!seenTypeHintPositions.has(obj.position)) {
                        seenTypeHintPositions.add(obj.position);
                        const position = convertSpan(obj.position, lineBreaks);
                        const hint_string = "try ";
                        const hint = InlayHint.create(
                            position,
                            [InlayHintLabelPart.create(hint_string)],
                            InlayHintKind.Type
                        );

                        textDocument.jaktInlayHints.push(hint);
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }

        // Send the computed diagnostics to VSCode.
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
    });
}

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
