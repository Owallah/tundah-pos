'use client';

import { useState } from 'react';

/**
 * Brand — the Tundah Taamu Delights mark.
 *
 * Drop the logo files into /public as:
 *   /public/logo.webp   (preferred — smaller)
 *   /public/logo.png    (fallback for older browsers)
 *
 * Until they are there, a wordmark badge renders instead, so no screen ever
 * shows a broken image. The <picture> element handles the webp/png choice
 * without JavaScript; the onError handler covers "neither file exists yet".
 */
export function Brand({
  size = 34, showName = true, subtitle,
}: { size?: number; showName?: boolean; subtitle?: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <span className="brand">
      {failed ? (
        <span className="brand__fallback" style={{ width: size, height: size }}
              aria-hidden="true">
          TT
        </span>
      ) : (
        <picture>
          <source srcSet="/tundah-taamu-logo-white.webp" type="image/webp" />
          <img
            src="/tundah-taamu-logo-white.png"
            alt=""
            width={size}
            height={size}
            className="brand__mark"
            style={{ width: size, height: size }}
            onError={() => setFailed(true)}
          />
        </picture>
      )}

      {showName && (
        <span className="brand__name">
          Tundah <b>Taamu</b> Delights
          {subtitle && <span className="brand__sub">{subtitle}</span>}
        </span>
      )}
    </span>
  );
}
