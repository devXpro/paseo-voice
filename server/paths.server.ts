import { homedir } from "node:os";
import path from "node:path";

/**
 * Everything this plugin downloads lives outside the plugin directory, under the same
 * plugin's own root. `paseo plugin remove voice`
 * deletes the plugin; it must not delete four gigabytes of weights somebody waited on,
 * nor the cloned voice they recorded themselves.
 *
 * A plugin cannot find out its own directory anyway, so there is no in-tree option.
 */
const root = path.join(homedir(), ".paseo-voice");

export const paths = {
  root,
  /** The engine binary, fetched from a GitHub release rather than built here. */
  binary: path.join(root, "bin", "qwen_tts"),
  binaryDir: path.join(root, "bin"),
  /** Records which release the binary on disk came from, so an update can be detected. */
  binaryStamp: path.join(root, "bin", "release.json"),
  modelsDir: path.join(root, "models"),
  /** Where the chosen provider, voice and tempo live. */
  state: path.join(root, "state.json"),
  /** One directory per model id, e.g. `models/1.7b-customvoice`. */
  model: (id: string) => path.join(root, "models", id),
  /** The Google API key, written by hand or by `gcloud`; never leaves this machine. */
  googleKey: path.join(root, "google-key.txt"),
  /** Drop any audio file here and it becomes a choice for the waiting cue. */
  musicDir: path.join(root, "music"),
  /** Characters sent per tier per month, so the surface can draw how much is left. */
  usage: path.join(root, "usage.json"),
};
