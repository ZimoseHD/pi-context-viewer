// Dev runner: serves the viewer on existing traces without pi.
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const m = await jiti.import(new URL("../src/server.ts", import.meta.url).pathname);
const server = m.createViewerServer((url) => console.log("SERVER:", url));
