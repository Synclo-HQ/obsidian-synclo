import type { App } from "obsidian";
import type { SecretStore } from "../auth/session";

/** Obsidian's secret storage: this device's keychain for this vault. */
export function secretStore(app: App): SecretStore {
  return {
    get: (id) => app.secretStorage.getSecret(id),
    set: (id, value) => app.secretStorage.setSecret(id, value),
  };
}
