import { fileURLToPath } from "node:url";
import { dirname } from "path";

export default function includeFlagForPath(file_path: string): string {
    if (file_path.startsWith("file://")) {
        file_path = decodeURI(file_path);
        return " -I " + dirname(fileURLToPath(file_path));
    }
    return " -I " + file_path;
}
