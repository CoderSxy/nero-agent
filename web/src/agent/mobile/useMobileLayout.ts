import { useEffect, useState } from 'react';

const QUERY = '(max-width: 767px)';

export function useMobileLayout(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia?.(QUERY).matches ?? window.innerWidth <= 767);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}
