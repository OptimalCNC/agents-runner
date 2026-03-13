import { marked } from "marked";
import DOMPurify from "dompurify";

export function renderMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  const raw = marked.parse(String(text), { breaks: true, gfm: true }) as string;
  return DOMPurify.sanitize(raw);
}
