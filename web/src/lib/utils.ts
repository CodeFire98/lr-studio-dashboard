import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn-standard className merger. Combines clsx (conditional class joins)
// with tailwind-merge (last-write-wins for conflicting Tailwind utilities).
// Used by every AI Elements component and any future shadcn primitives.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
