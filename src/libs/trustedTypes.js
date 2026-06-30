/**
 * @file trustedTypes.js
 * @description Helpers for writing sanitized HTML in pages with or without Trusted Types enforcement.
 */

import { logger } from "./log";
import DOMPurify from "dompurify";

export const trustedTypesHelper = (() => {
  const POLICY_NAME = "babel-policy";
  let policy = null;

  const domPurifyPolicy = {
    createHTML: (html) => html,
    createScriptURL: (url) => url,
  };
  const domPurifyConfig = {
    RETURN_TRUSTED_TYPE: false,
    TRUSTED_TYPES_POLICY: domPurifyPolicy,
  };

  const sanitizeHTML = (htmlString) =>
    DOMPurify.sanitize(String(htmlString ?? ""), domPurifyConfig);

  const createSanitizedFragment = (htmlString) =>
    DOMPurify.sanitize(String(htmlString ?? ""), {
      ...domPurifyConfig,
      RETURN_DOM_FRAGMENT: true,
    });

  const replaceChildrenSafely = (element, fragment) => {
    if (typeof element.replaceChildren === "function") {
      element.replaceChildren(fragment);
      return;
    }

    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
    element.appendChild(fragment);
  };

  const getErrorMessage = (err) => String(err?.message ?? err ?? "");

  const isPolicyAlreadyCreatedError = (err) =>
    getErrorMessage(err).includes("already exists");

  const isPolicyBlockedByCspError = (err) => {
    const message = getErrorMessage(err);
    return (
      message.includes("Content Security policy directive") ||
      message.includes("violates the following Content Security policy") ||
      message.includes("disallowed by trusted-types CSP")
    );
  };

  if (globalThis.trustedTypes?.createPolicy) {
    try {
      policy = globalThis.trustedTypes.createPolicy(POLICY_NAME, {
        createHTML: (string) => sanitizeHTML(string),
        createScript: (string) => string,
        createScriptURL: (string) => string,
      });
    } catch (err) {
      if (isPolicyAlreadyCreatedError(err)) {
        policy = globalThis.trustedTypes.policies?.get(POLICY_NAME) || null;
      } else if (isPolicyBlockedByCspError(err)) {
        logger.debug(
          "Trusted Types policy creation was blocked by page CSP; using sanitized DOM fallback."
        );
      } else {
        logger.info("cannot create Trusted Types policy", err);
      }
    }
  }

  return {
    /**
     * Create sanitized HTML. Returns TrustedHTML when the extension policy is available,
     * otherwise returns a sanitized string.
     * @param {string} htmlString
     */
    createHTML: (htmlString) => {
      return policy ? policy.createHTML(htmlString) : sanitizeHTML(htmlString);
    },
    /**
     * Safely write sanitized HTML. If the page rejects string innerHTML because
     * Trusted Types are enforced and our policy is disallowed, fall back to a
     * sanitized DOM fragment.
     * @param {Element} element
     * @param {string} htmlString
     */
    setHTML: (element, htmlString) => {
      if (!element) return;

      try {
        element.innerHTML = policy
          ? policy.createHTML(htmlString)
          : sanitizeHTML(htmlString);
      } catch (err) {
        replaceChildrenSafely(element, createSanitizedFragment(htmlString));
      }
    },
    /**
     * @param {string} scriptString
     */
    createScript: (scriptString) => {
      return policy ? policy.createScript(scriptString) : scriptString;
    },
    /**
     * @param {string} urlString
     */
    createScriptURL: (urlString) => {
      return policy ? policy.createScriptURL(urlString) : urlString;
    },
    /**
     * @returns {boolean}
     */
    isEnabled: () => policy !== null,
  };
})();
