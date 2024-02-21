import { Connection, HoverParams } from "vscode-languageserver";
import clickableFilePosition from "../utils/clickableFilePosition";
import convertPositionToIndex from "../utils/convertPositionToIndex";
import includeFlagForPath from "../utils/includeFlagForPath";
import logDuration from "../utils/logDuration";
import runCompiler from "../utils/runCompiler";
import { getDocumentManager } from "../documents";

import { fileURLToPath } from "node:url";

export function handleHover(connection: Connection) {
    return async (params: HoverParams) => {
        return await logDuration(`onHover ${clickableFilePosition(params)}`, async () => {
            const documentAndSettings = await getDocumentManager(connection).get(
                params.textDocument.uri
            );
            if (!documentAndSettings) return;
            const { document, settings } = documentAndSettings;

            const text = document.getText();

            if (!(typeof text == "string")) return null;

            const stdout = await runCompiler(
                connection,
                text,
                {
                    "-e": convertPositionToIndex(params.position, text),
                    "-I": includeFlagForPath(params.textDocument.uri),
                    "--assume-main-file-path": fileURLToPath(document.uri),
                },
                settings
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
    };
}
