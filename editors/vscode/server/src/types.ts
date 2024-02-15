import { TextDocument } from "vscode-languageserver-textdocument";
import { InlayHint } from "vscode-languageserver-protocol";

export interface JaktTextDocument extends TextDocument {
    jaktInlayHints?: InlayHint[];
}

export type JaktSymbol = {
    name: string;
    detail?: string;
    kind: "namespace" | "function" | "method" | "struct" | "class" | "enum" | "enum-member";
    range: { start: number; end: number };
    selection_range: { start: number; end: number };
    children: JaktSymbol[];
};

export type Settings = {
    maxNumberOfProblems: number;
    maxCompilerInvocationTime: number;
    extraCompilerImportPaths: Array<string>;
    compiler: {
        executablePath: string;
    };
    hints: {
        showImplicitTry: boolean;
        showInferredTypes: boolean;
    };
};
