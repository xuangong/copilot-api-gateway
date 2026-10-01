import type { DumpCapture, DumpCaptureBudget, DumpCaptureScope } from "../capture-budget.ts"

type Assert<T extends true> = T
type Capture = ReturnType<DumpCaptureBudget["open"]>["capture"]
type _NoRawRelease = Assert<"release" extends keyof DumpCaptureBudget ? false : true>
type _NoRawReserve = Assert<"reserve" extends keyof DumpCaptureBudget ? false : true>
type _CaptureHasNoRelease = Assert<"release" extends keyof Capture ? false : true>
type _CaptureHasNoRetirement = Assert<"retire" extends keyof Capture ? false : true>
type _CaptureViewMatches = Assert<Capture extends DumpCapture ? true : false>
type _OpenReturnsScope = Assert<ReturnType<DumpCaptureBudget["open"]> extends DumpCaptureScope ? true : false>
