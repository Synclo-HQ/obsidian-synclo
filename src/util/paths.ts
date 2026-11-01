/** A relative path ("../img/a.png") from a vault folder, as a vault path. */
export function joinRelative(folder: string, relative: string): string {
  const parts = folder ? folder.split("/").filter(Boolean) : [];
  for (const seg of relative.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
