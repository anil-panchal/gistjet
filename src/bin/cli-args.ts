export type CliCommand =
  | { kind: "serve" }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "tty-banner" };

export function parseCliArgs(argv: readonly string[], isTTY: boolean | undefined): CliCommand {
  const args = argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    return { kind: "version" };
  }

  if (args.includes("--help") || args.includes("-h")) {
    return { kind: "help" };
  }

  if (isTTY === true) {
    return { kind: "tty-banner" };
  }

  return { kind: "serve" };
}
