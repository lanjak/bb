import { stripVTControlCharacters } from "node:util";

export function printable(text: string): string {
  return stripVTControlCharacters(text).replace(/\p{Cc}/gu, "");
}

export function printableLines(text: string): string[] {
  return text.split("\n").map(printable);
}
