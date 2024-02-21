import { CompilerFlags } from "../types";

export default function compilerFlagsToString(
    flags: CompilerFlags,
    extraCompilerImportPaths?: string[]
): string {
    const joiner = " ";
    return [
        (Object.keys(flags) as Array<keyof CompilerFlags>)
            .map(key => {
                const value = flags[key];
                if (key === "--format-range") {
                    const [start, end] = value as NonNullable<CompilerFlags["--format-range"]>;
                    return `${key} ${start}:${end}`;
                }
                if (value === true) {
                    return key;
                }
                return `${key} ${value}`;
            })
            .join(joiner),
        (extraCompilerImportPaths ?? []).map(path => `-I ${path}`).join(joiner),
    ].join(joiner);
}
