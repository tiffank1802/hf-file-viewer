import { useEffect } from 'react';

const BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';

export default function CloudflareAnalytics() {
  const token = import.meta.env.VITE_CF_WEB_ANALYTICS_TOKEN;

  useEffect(() => {
    if (!token || import.meta.env.MODE !== 'production') return undefined;
    if (document.querySelector(`script[src="${BEACON_SRC}"]`)) return undefined;

    const script = document.createElement('script');
    script.defer = true;
    script.src = BEACON_SRC;
    script.setAttribute('data-cf-beacon', JSON.stringify({ token, spa: true }));
    document.body.appendChild(script);

    return () => {
      script.remove();
    };
  }, [token]);

  return null;
}
