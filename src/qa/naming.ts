import { LocatorEntry } from "../types.js";

/** Page-object action method name for a locator: enterUsernameInput, clickLoginButton, selectCountrySelect… */
export function methodNameFor(loc: LocatorEntry): string {
  const P = loc.key[0].toUpperCase() + loc.key.slice(1);
  switch (loc.elementType) {
    case "input":
    case "textarea":
      return `enter${P}`;
    case "select":
      return `select${P}`;
    case "checkbox":
    case "radio":
      return `set${P}`;
    case "heading":
    case "message":
      return `get${P}Text`;
    default:
      return `click${P}`;
  }
}
