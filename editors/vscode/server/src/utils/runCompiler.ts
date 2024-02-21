import { promisify } from "util";
import { Settings } from "../types";
import { exec as execWithCallback } from "child_process";
import { writeFileSync } from "fs";
import * as tmp from "tmp";

const exec = promisify(execWithCallback);

const tmpFile = tmp.fileSync();

export default async function runCompiler(
    text: string,
    flags: string,
    settings: Settings,
    options: { allowErrors?: boolean } = {},
    path?: string
): Promise<string> {
    const allowErrors = options.allowErrors === undefined ? true : options.allowErrors;

    try {
        writeFileSync(tmpFile.name, text);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
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
                console.log("compile failed: ");
                console.log(e);
            } else {
                console.log("Error:" + e);
            }
            throw e;
        } else {
            console.error(e);
        }
    }

    return stdout;
}
