import {
    Connection,
    DidChangeConfigurationParams,
    TextDocuments,
} from "vscode-languageserver/node";
import { DocumentUri, TextDocument } from "vscode-languageserver-textdocument";
import { Settings } from "./types";
import throttle from "./utils/throttle";
import { capabilities } from "./capabilities";
import validateTextDocument from "./utils/validateTextDocument";

const throttledValidateTextDocument = throttle(
    validateTextDocument,
    500
) as typeof validateTextDocument;

// Create a simple text document manager.
class DocumentsManager {
    private globalSettings: Settings = defaultSettings;

    private constructor(
        private connection: Connection,
        private documents: TextDocuments<TextDocument>,
        private settings: Map<string, Settings>
    ) {
        // Only keep settings for open documents
        documents.onDidClose(e => {
            settings.delete(e.document.uri);
        });

        // The content of a text document has changed. This event is emitted
        // when the text document first opened or when its content has changed.
        documents.onDidChangeContent(
            (() => {
                return async change => {
                    throttledValidateTextDocument(
                        this.connection,
                        change.document,
                        await this.getSettingsForDocument(change.document.uri)
                    );
                };
            })()
        );

        // Make the text document manager listen on the connection
        // for open, change and close text document events
        documents.listen(connection);
    }

    static initialize(connection: Connection): DocumentsManager {
        return new DocumentsManager(connection, new TextDocuments(TextDocument), new Map());
    }

    all(): TextDocument[] {
        return this.documents.all();
    }

    async get(uri: DocumentUri): Promise<{ document: TextDocument; settings: Settings } | null> {
        const document = this.documents.get(uri);
        if (!document) {
            return null;
        }
        return {
            document,
            settings: await this.getSettingsForDocument(uri),
        };
    }

    private async getSettingsForDocument(uri: DocumentUri): Promise<Settings> {
        if (!capabilities.hasConfigurationCapability) {
            return this.globalSettings;
        }
        const result = this.settings.get(uri);
        if (result) {
            return result;
        }

        const documentSettings =
            (await this.connection.workspace.getConfiguration({
                scopeUri: uri,
                section: "jaktLanguageServer",
            })) ?? defaultSettings;

        this.settings.set(uri, documentSettings);
        return documentSettings;
    }

    setDefaultSettings(settings: Settings) {
        this.globalSettings = settings;
    }

    async onDidChangeConfiguration(change: DidChangeConfigurationParams) {
        if (capabilities.hasConfigurationCapability) {
            // Reset all cached document settings
            this.settings.clear();
        } else {
            this.globalSettings = change.settings.jaktLanguageServer ?? defaultSettings;
        }

        // Revalidate all open text documents
        this.documents
            .all()
            .forEach(async document =>
                validateTextDocument(
                    this.connection,
                    document,
                    await this.getSettingsForDocument(document.uri)
                )
            );
    }
}

let documentsManager: DocumentsManager;
export function getDocumentManager(connection: Connection): DocumentsManager {
    if (documentsManager) {
        return documentsManager;
    }
    documentsManager = DocumentsManager.initialize(connection);
    return documentsManager;
}

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
