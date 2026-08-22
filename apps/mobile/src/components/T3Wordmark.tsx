import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";

/**
 * The "Tx" brand mark, matching the desktop sidebar's T3Wordmark SVG
 * (apps/web Sidebar.tsx). Width derives from the viewBox aspect ratio.
 */
export function T3Wordmark(props: { readonly height: number; readonly color: ColorValue }) {
  const aspectRatio = 94.3941 / 56.96;
  return (
    <Svg
      accessibilityLabel="Tx"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="15.5309 37 94.3941 56.96"
    >
      <Path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM65.925 51H81.565L109.925 93H94.285ZM65.925 93L94.285 51H109.925L81.565 93Z"
        fill={props.color}
      />
    </Svg>
  );
}
