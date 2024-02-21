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

export type CompilerFlags = {
    "-m"?: number;
    "-I"?: string;
    "-g"?: number;
    "-t"?: number;
    "-f"?: true;
    "--format-range"?: [number, number];
    "--print-symbols"?: true;
    "-e"?: number;
    "-c"?: true;
    "--type-hints"?: true;
    "--try-hints"?: true;
    "-j"?: true;
    "--assume-main-file-path"?: string;
};
