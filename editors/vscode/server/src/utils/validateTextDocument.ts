import {
    Diagnostic,
    DiagnosticSeverity,
    InlayHint,
    InlayHintLabelPart,
    InlayHintKind,
    Connection,
} from "vscode-languageserver/node";
import { JaktTextDocument, Settings } from "../types";
import convertSpan from "./convertSpan";
import findLineBreaks from "./findLineBreaks";
import includeFlagForPath from "./includeFlagForPath";
import logDuration from "./logDuration";
import runCompiler from "./runCompiler";
import { capabilities } from "../capabilities";
import { fileURLToPath } from "node:url";

export default async function validateTextDocument(
    connection: Connection,
    textDocument: JaktTextDocument,
    settings: Settings
) {
    await logDuration(`validateTextDocument ${textDocument.uri}`, async () => {
        if (!capabilities.hasDiagnosticRelatedInformationCapability) {
            console.error("Trying to validate a document with no diagnostic capability");
            return;
        }

        // The validator creates diagnostics for all uppercase words length 2 and more
        const text = textDocument.getText();

        const lineBreaks = findLineBreaks(text);

        const stdout = await runCompiler(
            connection,
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
