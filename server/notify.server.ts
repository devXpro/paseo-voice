import { execFile } from "node:child_process";

/**
 * A macOS notification, for what cannot wait until somebody opens the panel. Through
 * osascript because it is on every Mac. The text goes in as AppleScript string
 * literals, so quotes and backslashes in it are escaped rather than trusted.
 */
export function notify(title: string, text: string): Promise<void> {
  const literal = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", `display notification ${literal(text)} with title ${literal(title)} sound name "Glass"`],
      { timeout: 10_000 },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}
