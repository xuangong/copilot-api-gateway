// Exhaustive-check helper. Place at the end of a `switch` on a discriminated
// union so adding a new variant becomes a compile error at every consumer.
//
//   switch (result.type) {
//     case 'ok':    ...
//     case 'error': ...
//     default: assertNever(result)
//   }
//
// The runtime throw is a defensive backstop for truly-unreachable code paths.

export function assertNever(x: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(x)}`)
}
