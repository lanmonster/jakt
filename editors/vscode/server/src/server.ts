/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { handleInitialize, handleInitializeCompleted } from "./handlers/onInitialize";
import { handleDocumentSymbol } from "./handlers/onDocumentSymbol";
import { handleDefinition, handleTypeDefinition } from "./handlers/onDefinition";
import { handleHover } from "./handlers/onHover";
import { handleCompletion } from "./handlers/onCompletion";
import { handleDocumentFormat, handleDocumentRangeFormat } from "./handlers/onDocumentFormat";
import { handleConfigurationChange } from "./handlers/onDidChangeConfiguration";
import { handleInlayHint } from "./handlers/onInlayHint";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

connection.onInitialize(handleInitialize);
connection.onInitialized(handleInitializeCompleted(connection));

connection.onDocumentSymbol(handleDocumentSymbol(connection));

connection.onDefinition(handleDefinition(connection));

connection.onTypeDefinition(handleTypeDefinition(connection));

connection.onHover(handleHover(connection));

connection.onDidChangeConfiguration(handleConfigurationChange(connection));

// This handler provides the initial list of the completion items.
connection.onCompletion(handleCompletion(connection));

connection.onDocumentFormatting(handleDocumentFormat(connection));

connection.onDocumentRangeFormatting(handleDocumentRangeFormat(connection));

connection.languages.inlayHint.on(handleInlayHint(connection));

// Listen on the connection
connection.listen();
