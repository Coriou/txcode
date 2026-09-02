import type { SVGProps } from "react";

// Fork: Tx glyph (viewBox tightened at 15.5309 37 94.3941 56) — see session 7, FORK-STATE.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="15.5309 37 94.3941 56" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM65.925 51H81.565L109.925 93H94.285ZM65.925 93L94.285 51H109.925L81.565 93Z"
        fill="currentColor"
      />
    </svg>
  );
}
