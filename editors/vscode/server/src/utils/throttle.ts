/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Note: the fn cannot return a value.
 * @param fn the function you want to throttle
 * @param delay the number of ms you want to wait between each function call
 */
export default function throttle(fn: (...args: any) => void, delay: number) {
    let shouldWait = false;
    let waitingArgs: any | null;
    const timeoutFunc = () => {
        if (waitingArgs == null) {
            shouldWait = false;
        } else {
            fn(...waitingArgs);
            waitingArgs = null;
            setTimeout(timeoutFunc, delay);
        }
    };

    return (...args: any) => {
        if (shouldWait) {
            waitingArgs = args;
            return;
        }

        fn(...args);
        shouldWait = true;

        setTimeout(timeoutFunc, delay);
    };
}
