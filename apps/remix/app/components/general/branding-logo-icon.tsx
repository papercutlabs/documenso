import type { SVGAttributes } from 'react';

export type LogoProps = SVGAttributes<SVGSVGElement>;

export const BrandingLogoIcon = ({ ...props }: LogoProps) => {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" {...props}>
      <text
        x="0"
        y="46"
        fill="currentColor"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize="48"
        fontWeight="700"
      >
        PcL
      </text>
    </svg>
  );
};
