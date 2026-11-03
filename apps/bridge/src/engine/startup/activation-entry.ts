import { activateConfiguredEngine } from "./activation";
import { keepDiagnosticsNonFatal } from "./diagnostic-stream";

keepDiagnosticsNonFatal();
activateConfiguredEngine();
