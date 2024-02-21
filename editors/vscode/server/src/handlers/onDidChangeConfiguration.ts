import { Connection, DidChangeConfigurationParams } from "vscode-languageserver";
import { getDocumentManager } from "../documents";

type ConfigurationChangeHandler = (change: DidChangeConfigurationParams) => Promise<void>;
export function handleConfigurationChange(connection: Connection): ConfigurationChangeHandler {
    return async change => await getDocumentManager(connection).onDidChangeConfiguration(change);
}
