/** Escape user text before embedding it in a $regex — prevents both regex
 *  injection and accidental syntax errors from names like "O'Brien (Ops)". */
export function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
