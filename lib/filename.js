/** Sanitize names for chrome.downloads / filesystem. */

export function sanitizeFilename(name, fallback = `download-${Date.now()}`) {
  let n = String(name || "").trim();
  try {
    n = decodeURIComponent(n);
  } catch {
    /* keep raw */
  }
  n = n.split(/[/\\]/).pop() || n;
  n = n.replace(/[\u0000-\u001f<>:"|?*]/g, "_");
  n = n.replace(/\s+/g, " ").trim();
  // Windows trailing dots/spaces
  n = n.replace(/[.\s]+$/g, "");
  if (!n || n === "." || n === "..") n = fallback;
  if (n.length > 180) {
    const ext = n.includes(".") ? n.slice(n.lastIndexOf(".")) : "";
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}
