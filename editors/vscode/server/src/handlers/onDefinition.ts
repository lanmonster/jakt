import { Connection, DefinitionParams, TypeDefinitionParams } from "vscode-languageserver/node";
import clickableFilePosition from "../utils/clickableFilePosition";
import convertPositionToIndex from "../utils/convertPositionToIndex";
import goToDefinition from "../utils/goToDefinition";
import includeFlagForPath from "../utils/includeFlagForPath";
import logDuration from "../utils/logDuration";
import runCompiler from "../utils/runCompiler";

import { fileURLToPath } from "node:url";
import { getDocumentManager } from "../documents";

export function handleDefinition(connection: Connection) {
    return async (params: DefinitionParams) =>
        await logDuration(`onDefinition ${clickableFilePosition(params)}`, async () => {
            const documentAndSettings = await getDocumentManager(connection).get(
                params.textDocument.uri
            );
            if (!documentAndSettings) return;
            const { document, settings } = documentAndSettings;

            const text = document.getText();

            const stdout = await runCompiler(
                connection,
                text,
                "-g " +
                    convertPositionToIndex(params.position, text) +
                    includeFlagForPath(params.textDocument.uri),
                settings,
                {},
                fileURLToPath(document.uri)
            );
            return await goToDefinition(document, stdout);
        });
}

export function handleTypeDefinition(connection: Connection) {
    return async (params: TypeDefinitionParams) => {
        return await logDuration(`onTypeDefinition ${clickableFilePosition(params)}`, async () => {
            const documentAndSettings = await getDocumentManager(connection).get(
                params.textDocument.uri
            );
            if (!documentAndSettings) return;
            const { document, settings } = documentAndSettings;

            const text = document.getText();
            const stdout = await runCompiler(
                connection,
                text,
                "-t " +
                    convertPositionToIndex(params.position, text) +
                    includeFlagForPath(params.textDocument.uri),
                settings,
                {},
                fileURLToPath(document.uri)
            );
            return goToDefinition(document, stdout);
        });
    };
}
