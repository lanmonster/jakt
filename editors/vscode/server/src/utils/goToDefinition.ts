import { HandlerResult, Definition } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import convertSpan from "./convertSpan";
import findLineBreaks from "./findLineBreaks";
import logDuration from "./logDuration";

import * as fs from "fs";

export default async function goToDefinition(
    document: TextDocument,
    jaktOutput: string
): Promise<HandlerResult<Definition, void> | undefined> {
    return await logDuration(`goToDefinition`, async () => {
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
