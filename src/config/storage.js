/**
 * Storage key definitions.
 *
 * Keep these keys independent from the display app name. Renaming the product
 * should not reset a user's language, subtitle styles, rules, or auth caches.
 */

import { APP_VERSION } from "./app";

export const APP_STORAGE_NAMESPACE = "babel";

const LEGACY_STORAGE_NAMESPACE = ["KISS", "Translator"].join("-");
const PREVIOUS_BABEL_STORAGE_NAMESPACE = "Babel";
const LEGACY_STORAGE_NAMESPACES = [
  LEGACY_STORAGE_NAMESPACE,
  PREVIOUS_BABEL_STORAGE_NAMESPACE,
];

const namespacedKey = (name) => `${APP_STORAGE_NAMESPACE}_${name}`;
const legacyNamespacedKeys = (name) =>
  LEGACY_STORAGE_NAMESPACES.map((namespace) => `${namespace}_${name}`);

// Remote sync JSON filenames.
export const KV_RULES_KEY = `babel-rules_v${APP_VERSION[0]}.json`;
export const KV_WORDS_KEY = "babel-words.json";
export const KV_RULES_SHARE_KEY = `babel-rules-share_v${APP_VERSION[0]}.json`;
export const KV_SETTING_KEY = `babel-setting_v${APP_VERSION[0]}.json`;
export const KV_SALT_SYNC = "Babel-SYNC";
export const KV_SALT_SHARE = "Babel-SHARE";

// Local browser storage keys.
export const STOKEY_MSAUTH = namespacedKey("msauth");
export const STOKEY_BDAUTH = namespacedKey("bdauth");
export const STOKEY_SETTING_OLD = namespacedKey("setting");
export const STOKEY_RULES_OLD = namespacedKey("rules");
export const STOKEY_SETTING = namespacedKey(`setting_v${APP_VERSION[0]}`);
export const STOKEY_RULES = namespacedKey(`rules_v${APP_VERSION[0]}`);
export const STOKEY_WORDS = namespacedKey("words");
export const STOKEY_SYNC = namespacedKey("sync");
export const STOKEY_FAB = namespacedKey("fab");
export const STOKEY_TRANBOX = namespacedKey("tranbox");
export const STOKEY_SEPARATE_WINDOW = namespacedKey("separate_window");
export const STOKEY_RULESCACHE_PREFIX = namespacedKey("rulescache_");
export const STOKEY_DISABLED_SUB_RULES = namespacedKey("disabled_sub_rules");

export const STORAGE_FALLBACK_KEYS = {
  [STOKEY_MSAUTH]: legacyNamespacedKeys("msauth"),
  [STOKEY_BDAUTH]: legacyNamespacedKeys("bdauth"),
  [STOKEY_SETTING_OLD]: legacyNamespacedKeys("setting"),
  [STOKEY_RULES_OLD]: legacyNamespacedKeys("rules"),
  [STOKEY_SETTING]: legacyNamespacedKeys(`setting_v${APP_VERSION[0]}`).concat(
    legacyNamespacedKeys("setting")
  ),
  [STOKEY_RULES]: legacyNamespacedKeys(`rules_v${APP_VERSION[0]}`).concat(
    legacyNamespacedKeys("rules")
  ),
  [STOKEY_WORDS]: legacyNamespacedKeys("words"),
  [STOKEY_SYNC]: legacyNamespacedKeys("sync"),
  [STOKEY_FAB]: legacyNamespacedKeys("fab"),
  [STOKEY_TRANBOX]: legacyNamespacedKeys("tranbox"),
  [STOKEY_SEPARATE_WINDOW]: legacyNamespacedKeys("separate_window"),
  [STOKEY_DISABLED_SUB_RULES]: legacyNamespacedKeys("disabled_sub_rules"),
};

// Translation HTTP cache settings.
export const CACHE_NAME = namespacedKey("cache");
export const DEFAULT_CACHE_TIMEOUT = 3600 * 24 * 7;
