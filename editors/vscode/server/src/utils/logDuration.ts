export default async function logDuration<T>(label: string, fn: () => Promise<T>): Promise<T> {
    console.log("Triggered " + label + ": ...");
    console.time(label);
    const result = await fn();

    // This purposefully has the same prefix length as the "Triggered " log above,
    // also does not add a newline at the end.
    process.stdout.write("Finished  ");
    console.timeEnd(label);
    return new Promise<T>(resolve => resolve(result));
}
