import * as fs from "fs";
import * as tmp from "tmp";
import { Settings } from "../types";
import { promisify } from "node:util";
import { exec as execWithCallback } from "node:child_process";
import { Connection } from "vscode-languageserver/node";

const tmpFile = tmp.fileSync();

const exec = promisify(execWithCallback);

export default async function runCompiler(
    connection: Connection,
    text: string,
    flags: string,
    settings: Settings,
    options: { allowErrors?: boolean } = {},
    path?: string
): Promise<string> {
    const allowErrors = options.allowErrors === undefined ? true : options.allowErrors;

    try {
        fs.writeFileSync(tmpFile.name, text);
    } catch (e: unknown) {
        // connection.console.log(e);
    }

    const assume_main_file = path ? `--assume-main-file-path ${path}` : ``;
    const command = `${
        settings.compiler.executablePath
    } ${assume_main_file} ${flags} ${settings.extraCompilerImportPaths
        .map(x => "-I " + x)
        .join(" ")} ${tmpFile.name}`;

    console.info(`Running command: ${command}`);

    let stdout = "";
    try {
        const output = await exec(command, {
            timeout: settings.maxCompilerInvocationTime,
        });
        stdout = output.stdout;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
        stdout = e.stdout;
        if (!allowErrors) {
            if (e.signal != null) {
                connection.console.log("compile failed: ");
                connection.console.log(e);
            } else {
                connection.console.log("Error:" + e);
            }
            throw e;
        } else {
            console.error(e);
        }
    }

    return stdout;
}
