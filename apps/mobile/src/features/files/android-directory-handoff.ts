import { createFileHandoffAtoms } from "@t3tools/client-runtime/state/fileHandoff";

import { connectionAtomRuntime } from "../../connection/runtime";

export const androidDirectoryHandoff = createFileHandoffAtoms(connectionAtomRuntime);
export const androidDirectoryQuiet = { reportFailure: false, reportDefect: false };
