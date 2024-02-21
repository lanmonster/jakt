import {
    Connection,
    DidChangeConfigurationNotification,
    InitializeParams,
    InitializeResult,
    TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { capabilities } from "../capabilities";

export function handleInitialize(params: InitializeParams): InitializeResult {
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
}

type InitializeCompletedHandler = () => void;
export function handleInitializeCompleted(connection: Connection): InitializeCompletedHandler {
    return () => {
        if (capabilities.hasConfigurationCapability) {
            // Register for all configuration changes.
            connection.client.register(DidChangeConfigurationNotification.type, undefined);
        }
    };
}
