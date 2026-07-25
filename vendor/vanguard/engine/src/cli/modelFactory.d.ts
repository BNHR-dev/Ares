import { HttpModelAdapter, type StreamObserver } from "../index.js";
import type { CliOptions } from "./options.js";
export declare function createModel(options: CliOptions, streamObserver?: StreamObserver): HttpModelAdapter;
